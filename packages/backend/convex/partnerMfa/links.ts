import { v } from "convex/values"

import { internal } from "../_generated/api"
import { internalMutation, internalQuery, mutation, query } from "../_generated/server"
import { requireAuth } from "../lib/auth"
import { activeDevicesOf, activeLinkOf, cancelPendingRequests, findSubject } from "./store"

/**
 * Liens (utilisateur, partenaire). Un lien autorise les demandes `login` et
 * `sensitive` et la vérification de codes pour ce partenaire.
 *
 * Deux côtés : l'app (`myLinks`, `revokeLink`, en session) et le partenaire
 * (`linkStatus`, `revokeForSubject`, appelés par `partnerMfa/http.ts`).
 */

const linkView = v.object({
  clientId: v.string(),
  clientName: v.string(),
  clientIcon: v.union(v.string(), v.null()),
  createdAt: v.number(),
})

export const myLinks = query({
  args: {},
  returns: v.array(linkView),
  handler: async (ctx) => {
    const user = await requireAuth(ctx)
    const rows = await ctx.db
      .query("partnerMfaLink")
      .withIndex("by_userId", (q) => q.eq("userId", user.userId))
      .take(100)
    return rows
      .filter((row) => row.revokedAt === undefined)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((row) => ({
        clientId: row.clientId,
        clientName: row.clientName,
        clientIcon: row.clientIcon ?? null,
        createdAt: row.createdAt,
      }))
  },
})

export const revokeLink = mutation({
  args: { clientId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requireAuth(ctx)
    const link = await activeLinkOf(ctx, user.userId, args.clientId)
    if (!link) return null
    const now = Date.now()
    await ctx.db.patch(link._id, { revokedAt: now })
    await cancelPendingRequests(ctx, user.userId, args.clientId, now)
    await ctx.runMutation(internal.audit.recordAudit, {
      actorId: user.userId,
      action: "partner_mfa_link_revoked",
      targetType: "user",
      targetId: user.userId,
      metadata: { by: "user", clientId: args.clientId },
    })
    return null
  },
})

/** `GET /partner-mfa/v1/links/status` : lien de CE partenaire et nombre d'appareils. */
export const linkStatus = internalQuery({
  args: { clientId: v.string(), sub: v.string() },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      linked: v.boolean(),
      devices: v.number(),
    }),
    v.object({ ok: v.literal(false), error: v.literal("unknown_subject") }),
  ),
  handler: async (ctx, args) => {
    const userId = await findSubject(ctx, args.sub)
    if (!userId) return { ok: false as const, error: "unknown_subject" as const }
    const link = await activeLinkOf(ctx, userId, args.clientId)
    const devices = await activeDevicesOf(ctx, userId)
    return { ok: true as const, linked: link !== null, devices: devices.length }
  },
})

/** `POST /partner-mfa/v1/links/revoke` : le partenaire retire son propre lien. */
export const revokeForSubject = internalMutation({
  args: { clientId: v.string(), sub: v.string() },
  returns: v.union(
    v.object({ ok: v.literal(true) }),
    v.object({ ok: v.literal(false), error: v.literal("unknown_subject") }),
  ),
  handler: async (ctx, args) => {
    const userId = await findSubject(ctx, args.sub)
    if (!userId) return { ok: false as const, error: "unknown_subject" as const }
    const link = await activeLinkOf(ctx, userId, args.clientId)
    if (link) {
      const now = Date.now()
      await ctx.db.patch(link._id, { revokedAt: now })
      await cancelPendingRequests(ctx, userId, args.clientId, now)
      await ctx.runMutation(internal.audit.recordAudit, {
        actorId: undefined,
        action: "partner_mfa_link_revoked",
        targetType: "user",
        targetId: userId,
        metadata: { by: "partner", clientId: args.clientId },
      })
    }
    return { ok: true as const }
  },
})
