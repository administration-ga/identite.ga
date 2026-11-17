import { ConvexError, v } from "convex/values"

import { internal } from "../_generated/api"
import type { Doc, Id } from "../_generated/dataModel"
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server"
import { requireAuth } from "../lib/auth"
import { rateLimiter } from "../rateLimiter"
import {
  REQUEST_TTL_MS,
  drawChallenge,
  effectiveStatus,
  type StoredRequestStatus,
} from "./rules"
import { activeDevicesOf, activeLinkOf, findSubject } from "./store"

/**
 * Demandes de confirmation (ADR-0007 §6).
 *
 * Cycle : le partenaire crée une demande (`createRequest`, via HTTP) ; le serveur
 * tire un nombre à 2 chiffres et 3 choix, envoie une notification ; l'app
 * affiche les 3 choix ; `respond` compare côté serveur. Le nombre ne quitte
 * jamais le serveur vers l'app : `myPending` et `get` ne le renvoient pas.
 */

const statusValidator = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("denied"),
  v.literal("wrong_number"),
  v.literal("cancelled"),
  v.literal("expired"),
)

const kindValidator = v.union(
  v.literal("enroll"),
  v.literal("login"),
  v.literal("sensitive"),
)

const contextValidator = v.object({
  device: v.optional(v.string()),
  ip: v.optional(v.string()),
  location: v.optional(v.string()),
})

/** Vue côté app : aucun nombre, seulement les trois choix. */
const requestView = v.object({
  id: v.string(),
  clientName: v.string(),
  clientIcon: v.union(v.string(), v.null()),
  kind: kindValidator,
  actionLabel: v.union(v.string(), v.null()),
  context: contextValidator,
  choices: v.array(v.string()),
  status: statusValidator,
  createdAt: v.number(),
  expiresAt: v.number(),
  decidedAt: v.union(v.number(), v.null()),
})

type RequestRow = Doc<"partnerMfaRequest">

function toView(row: RequestRow, now: number) {
  return {
    id: row._id,
    clientName: row.clientName,
    clientIcon: row.clientIcon ?? null,
    kind: row.kind,
    actionLabel: row.actionLabel ?? null,
    context: row.context,
    choices: row.choices,
    status: effectiveStatus(row, now),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    decidedAt: row.decidedAt ?? null,
  }
}

/** Demande de l'utilisateur courant uniquement. Null sinon, sans distinguer. */
async function loadOwned(
  ctx: QueryCtx | MutationCtx,
  userId: string,
  id: string,
): Promise<RequestRow | null> {
  const requestId = ctx.db.normalizeId("partnerMfaRequest", id)
  if (!requestId) return null
  const row = await ctx.db.get(requestId)
  return row && row.userId === userId ? row : null
}

async function recordDecision(
  ctx: MutationCtx,
  userId: string,
  requestId: Id<"partnerMfaRequest">,
  outcome: StoredRequestStatus,
  kind: RequestRow["kind"],
) {
  await ctx.runMutation(internal.audit.recordAudit, {
    actorId: userId,
    action: "partner_mfa_request_decided",
    targetType: "user",
    targetId: userId,
    metadata: { requestId, outcome, kind },
  })
}

// ---------------------------------------------------------------------------
// Côté partenaire (HTTP, via partnerMfa/http.ts)
// ---------------------------------------------------------------------------

export const createRequest = internalMutation({
  args: {
    clientId: v.string(),
    clientName: v.string(),
    clientIcon: v.optional(v.string()),
    sub: v.string(),
    kind: kindValidator,
    actionLabel: v.optional(v.string()),
    context: contextValidator,
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      requestId: v.string(),
      number: v.string(),
      expiresAt: v.number(),
    }),
    v.object({
      ok: v.literal(false),
      error: v.union(
        v.literal("rate_limited"),
        v.literal("unknown_subject"),
        v.literal("not_linked"),
        v.literal("no_device"),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    // Quota avant toute lecture : une demande refusée consomme quand même le
    // quota, ce qui freine l'énumération de sujets.
    const limit = await rateLimiter.limit(ctx, "partnerMfaRequestCreate", {
      key: `${args.clientId}:${args.sub}`,
      throws: false,
    })
    if (!limit.ok) return { ok: false as const, error: "rate_limited" as const }

    const userId = await findSubject(ctx, args.sub)
    if (!userId) return { ok: false as const, error: "unknown_subject" as const }

    if (args.kind !== "enroll") {
      const link = await activeLinkOf(ctx, userId, args.clientId)
      if (!link) return { ok: false as const, error: "not_linked" as const }
    }

    if ((await activeDevicesOf(ctx, userId)).length === 0) {
      return { ok: false as const, error: "no_device" as const }
    }

    const now = Date.now()
    const expiresAt = now + REQUEST_TTL_MS
    const challenge = drawChallenge()
    const requestId = await ctx.db.insert("partnerMfaRequest", {
      userId,
      clientId: args.clientId,
      clientName: args.clientName,
      clientIcon: args.clientIcon,
      kind: args.kind,
      actionLabel: args.actionLabel,
      context: args.context,
      number: challenge.number,
      choices: challenge.choices,
      status: "pending",
      createdAt: now,
      expiresAt,
    })

    // Texte sans donnée sensible : il transite par le service de notifications.
    await ctx.scheduler.runAfter(0, internal.push.deliver.notification, {
      userId,
      title: "Confirmation demandée",
      body: `${args.clientName} te demande de confirmer que c’est bien toi.`,
      url: `/confirm?id=${requestId}`,
      // L'écran de confirmation n'existe que dans l'app mobile.
      nativeOnly: true,
    })

    return {
      ok: true as const,
      requestId,
      number: challenge.number,
      expiresAt,
    }
  },
})

/** `GET /partner-mfa/v1/requests/status` : uniquement les demandes de ce partenaire. */
export const partnerStatus = internalQuery({
  args: { clientId: v.string(), requestId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      status: statusValidator,
      decidedAt: v.optional(v.number()),
    }),
  ),
  handler: async (ctx, args) => {
    const requestId = ctx.db.normalizeId("partnerMfaRequest", args.requestId)
    if (!requestId) return null
    const row = await ctx.db.get(requestId)
    if (!row || row.clientId !== args.clientId) return null
    return {
      status: effectiveStatus(row, Date.now()),
      decidedAt: row.decidedAt,
    }
  },
})

/** `POST /partner-mfa/v1/requests/cancel` : annulation par le partenaire. */
export const partnerCancel = internalMutation({
  args: { clientId: v.string(), requestId: v.string() },
  returns: v.union(
    v.object({ ok: v.literal(true) }),
    v.object({ ok: v.literal(false), error: v.literal("not_found") }),
    v.object({
      ok: v.literal(false),
      error: v.literal("request_closed"),
      status: statusValidator,
    }),
  ),
  handler: async (ctx, args) => {
    const requestId = ctx.db.normalizeId("partnerMfaRequest", args.requestId)
    const row = requestId ? await ctx.db.get(requestId) : null
    if (!requestId || !row || row.clientId !== args.clientId) {
      return { ok: false as const, error: "not_found" as const }
    }
    const now = Date.now()
    const status = effectiveStatus(row, now)
    if (status !== "pending") {
      return {
        ok: false as const,
        error: "request_closed" as const,
        status,
      }
    }
    await ctx.db.patch(requestId, { status: "cancelled", decidedAt: now })
    return { ok: true as const }
  },
})

// ---------------------------------------------------------------------------
// Côté app (session de l'utilisateur)
// ---------------------------------------------------------------------------

/** Demandes en attente et non échues. Jamais le nombre. */
export const myPending = query({
  args: {},
  returns: v.array(requestView),
  handler: async (ctx) => {
    const user = await requireAuth(ctx)
    const now = Date.now()
    const rows = await ctx.db
      .query("partnerMfaRequest")
      .withIndex("by_userId_and_status", (q) =>
        q.eq("userId", user.userId).eq("status", "pending"),
      )
      // Les plus récentes d'abord : une demande ignorée reste `pending` en base
      // après son échéance. Lues dans l'ordre d'insertion, une vingtaine de
      // demandes ignorées masqueraient la demande en cours.
      .order("desc")
      .take(20)
    return rows
      .filter((row) => row.expiresAt > now)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((row) => toView(row, now))
  },
})

/** Une demande de l'utilisateur, avec son statut courant. Jamais le nombre. */
export const get = query({
  args: { id: v.string() },
  returns: v.union(requestView, v.null()),
  handler: async (ctx, args) => {
    const user = await requireAuth(ctx)
    const row = await loadOwned(ctx, user.userId, args.id)
    return row ? toView(row, Date.now()) : null
  },
})

/**
 * Réponse au nombre : le serveur compare. Un mauvais choix clôt la demande en
 * `wrong_number`. Une demande `enroll` approuvée crée (ou rétablit) le lien.
 * Renvoie le statut résultant ; une demande déjà tranchée ne change plus.
 */
export const respond = mutation({
  args: {
    id: v.string(),
    choice: v.string(),
    installationId: v.optional(v.string()),
  },
  returns: v.object({ status: statusValidator }),
  handler: async (ctx, args) => {
    const user = await requireAuth(ctx)
    const row = await loadOwned(ctx, user.userId, args.id)
    if (!row) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Demande introuvable." })
    }
    const now = Date.now()
    const current = effectiveStatus(row, now)
    if (current !== "pending") {
      if (row.status === "pending") await ctx.db.patch(row._id, { status: "expired" })
      return { status: current }
    }
    if (!row.choices.includes(args.choice)) {
      throw new ConvexError({
        code: "INVALID_CHOICE",
        message: "Ce choix ne fait pas partie de la demande.",
      })
    }

    let deviceInstallationId: string | undefined
    if (args.installationId !== undefined) {
      const device = (await activeDevicesOf(ctx, user.userId)).find(
        (d) => d.installationId === args.installationId,
      )
      if (!device) {
        throw new ConvexError({
          code: "DEVICE_UNKNOWN",
          message: "Cet appareil n'est pas enregistré pour ce compte.",
        })
      }
      deviceInstallationId = device.installationId
    }

    const outcome: StoredRequestStatus =
      args.choice === row.number ? "approved" : "wrong_number"
    await ctx.db.patch(row._id, {
      status: outcome,
      decidedAt: now,
      deviceInstallationId,
    })
    await recordDecision(ctx, user.userId, row._id, outcome, row.kind)

    if (outcome === "approved" && row.kind === "enroll") {
      const existing = await ctx.db
        .query("partnerMfaLink")
        .withIndex("by_userId_and_clientId", (q) =>
          q.eq("userId", user.userId).eq("clientId", row.clientId),
        )
        .unique()
      if (existing) {
        await ctx.db.patch(existing._id, {
          revokedAt: undefined,
          clientName: row.clientName,
          clientIcon: row.clientIcon,
        })
      } else {
        await ctx.db.insert("partnerMfaLink", {
          userId: user.userId,
          clientId: row.clientId,
          clientName: row.clientName,
          clientIcon: row.clientIcon,
          createdAt: now,
        })
      }
      await ctx.runMutation(internal.audit.recordAudit, {
        actorId: user.userId,
        action: "partner_mfa_link_created",
        targetType: "user",
        targetId: user.userId,
        metadata: { clientId: row.clientId, requestId: row._id },
      })
    }

    return { status: outcome }
  },
})

/** Refus explicite : « Non, ce n'était pas moi ». */
export const deny = mutation({
  args: { id: v.string() },
  returns: v.object({ status: statusValidator }),
  handler: async (ctx, args) => {
    const user = await requireAuth(ctx)
    const row = await loadOwned(ctx, user.userId, args.id)
    if (!row) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Demande introuvable." })
    }
    const now = Date.now()
    const current = effectiveStatus(row, now)
    if (current !== "pending") {
      if (row.status === "pending") await ctx.db.patch(row._id, { status: "expired" })
      return { status: current }
    }
    await ctx.db.patch(row._id, { status: "denied", decidedAt: now })
    await recordDecision(ctx, user.userId, row._id, "denied", row.kind)
    return { status: "denied" as const }
  },
})

const historyView = v.object({
  id: v.string(),
  clientName: v.string(),
  clientIcon: v.union(v.string(), v.null()),
  kind: kindValidator,
  actionLabel: v.union(v.string(), v.null()),
  status: statusValidator,
  createdAt: v.number(),
  decidedAt: v.union(v.number(), v.null()),
})

/** Les 30 dernières demandes tranchées (ou échues). */
export const myHistory = query({
  args: {},
  returns: v.array(historyView),
  handler: async (ctx) => {
    const user = await requireAuth(ctx)
    const now = Date.now()
    const rows = await ctx.db
      .query("partnerMfaRequest")
      .withIndex("by_userId", (q) => q.eq("userId", user.userId))
      .order("desc")
      .take(60)
    return rows
      .map((row) => ({ row, status: effectiveStatus(row, now) }))
      .filter(({ status }) => status !== "pending")
      .slice(0, 30)
      .map(({ row, status }) => ({
        id: row._id,
        clientName: row.clientName,
        clientIcon: row.clientIcon ?? null,
        kind: row.kind,
        actionLabel: row.actionLabel ?? null,
        status,
        createdAt: row.createdAt,
        decidedAt: row.decidedAt ?? null,
      }))
  },
})
