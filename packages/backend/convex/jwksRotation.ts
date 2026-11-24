import { createJwk } from "better-auth/plugins/jwt"
import { ConvexError, v } from "convex/values"

import { components, internal } from "./_generated/api"
import type { ActionCtx } from "./_generated/server"
import { internalAction } from "./_generated/server"
import { createAuth } from "./auth"
import {
  DAY_MS,
  isAutoRotationEnabled,
  planKeyMaintenance,
  type KeyRow,
} from "./lib/jwksRotationPolicy"
import { rsaModulusBits, SIGNING_KEY_PAIR_CONFIG } from "./lib/signingKeys"

/**
 * Rotation des clés de signature d'IDN (ID tokens OIDC et JWT Convex) —
 * CH-820, ADR 0002. Fonctions INTERNES : `convex run` (clé
 * d'administration) ou la tâche planifiée quotidienne `tick`.
 *
 *   bunx convex run jwksRotation:list
 *   bunx convex run jwksRotation:rotate '{"force":true}'
 *   bunx convex run jwksRotation:prune
 *   bunx convex run jwksRotation:revoke '{"kid":"…"}'
 *
 * La rotation automatique ne s'arme qu'avec `IDN_JWKS_AUTO_ROTATION=enabled`,
 * posé par le propriétaire après une première rotation manuelle en
 * production. Sans elle, `tick` purge les clés remplacées et journalise l'âge
 * de la clé active.
 *
 * Jamais la rotation intégrée du plugin convex de @convex-dev/better-auth :
 * elle supprime TOUTES les clés avant d'en créer une, ce qui rejette chaque
 * jeton encore valide (un test vérifie qu'aucune source ne l'appelle).
 */

const keyInfo = v.object({
  kid: v.string(),
  createdAt: v.number(),
  ageDays: v.number(),
  modulusBits: v.number(),
  active: v.boolean(),
})

type StoredKey = { _id: string; createdAt: number; publicKey: string }

async function readKeys(ctx: ActionCtx): Promise<StoredKey[]> {
  const result = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
    model: "jwks",
    paginationOpts: { numItems: 100, cursor: null },
  })) as { page: StoredKey[] }
  return [...result.page].sort((a, b) => b.createdAt - a.createdAt)
}

const describeKeys = (keys: StoredKey[], now: number) =>
  keys.map((key, index) => ({
    kid: key._id,
    createdAt: key.createdAt,
    ageDays: Math.floor(((now - key.createdAt) / DAY_MS) * 10) / 10,
    modulusBits: rsaModulusBits(key.publicKey),
    // Better Auth signe avec la plus récente.
    active: index === 0,
  }))

const asRows = (keys: StoredKey[]): KeyRow[] => keys.map((k) => ({ id: k._id, createdAt: k.createdAt }))

/**
 * Crée une clé par le `createJwk` de Better Auth (clé privée chiffrée avec
 * BETTER_AUTH_SECRET, comme celles qu'il crée lui-même) : elle devient la
 * plus récente, donc la clé de signature.
 */
async function createSigningKey(ctx: ActionCtx): Promise<string> {
  const auth = createAuth(ctx) as unknown as { $context: Promise<unknown> }
  const context = await auth.$context
  const jwk = await createJwk({ context } as Parameters<typeof createJwk>[0], {
    jwks: { keyPairConfig: SIGNING_KEY_PAIR_CONFIG },
  })
  return jwk.id
}

async function deleteKey(ctx: ActionCtx, kid: string): Promise<void> {
  await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
    input: { model: "jwks", where: [{ field: "_id", value: kid, operator: "eq" }] },
  })
}

type RotationAuditAction = "jwks_key_rotated" | "jwks_key_pruned" | "jwks_key_revoked"

async function audit(
  ctx: ActionCtx,
  action: RotationAuditAction,
  metadata: Record<string, unknown>,
): Promise<void> {
  await ctx.runMutation(internal.audit.recordAudit, {
    action,
    targetType: "system",
    targetId: String(metadata.kid ?? "jwks"),
    metadata,
  })
}

/** Clés publiées, la plus récente (active) en tête. Aucune clé privée. */
export const list = internalAction({
  args: {},
  returns: v.array(keyInfo),
  handler: async (ctx) => describeKeys(await readKeys(ctx), Date.now()),
})

/**
 * Crée la clé suivante. Sans `force`, n'agit que si la règle le permet
 * (rotation armée et clé active de plus de 90 jours, jamais à moins de 7
 * jours de la précédente).
 */
export const rotate = internalAction({
  args: { force: v.optional(v.boolean()) },
  returns: v.object({ rotated: v.boolean(), reason: v.string(), kid: v.optional(v.string()) }),
  handler: async (ctx, { force }) => {
    const keys = await readKeys(ctx)
    const plan = planKeyMaintenance(asRows(keys), Date.now(), {
      autoRotate: isAutoRotationEnabled(process.env.IDN_JWKS_AUTO_ROTATION),
      force: force === true,
    })
    if (!plan.rotate) return { rotated: false, reason: plan.reason }
    const kid = await createSigningKey(ctx)
    await audit(ctx, "jwks_key_rotated", { kid, reason: plan.reason, previous: keys[0]?._id ?? null })
    return { rotated: true, reason: plan.reason, kid }
  },
})

/** Retire du JWKS les clés remplacées depuis plus de 7 jours. */
export const prune = internalAction({
  args: {},
  returns: v.object({ pruned: v.array(v.string()) }),
  handler: async (ctx) => {
    const keys = await readKeys(ctx)
    const plan = planKeyMaintenance(asRows(keys), Date.now(), { autoRotate: false })
    for (const kid of plan.prune) {
      await deleteKey(ctx, kid)
      await audit(ctx, "jwks_key_pruned", { kid })
    }
    return { pruned: plan.prune }
  },
})

/**
 * Retrait immédiat d'une clé (compromission, ou retour arrière d'une
 * rotation). La clé active ne se retire qu'avec `confirmLatest`, et une
 * nouvelle clé est alors créée d'abord : le JWKS n'est jamais vide.
 */
export const revoke = internalAction({
  args: { kid: v.string(), confirmLatest: v.optional(v.boolean()) },
  returns: v.object({ revoked: v.string(), replacement: v.optional(v.string()) }),
  handler: async (ctx, { kid, confirmLatest }) => {
    const keys = await readKeys(ctx)
    const target = keys.find((key) => key._id === kid)
    if (!target) throw new ConvexError({ code: "NOT_FOUND", message: `Clé inconnue : ${kid}` })
    let replacement: string | undefined
    if (keys[0]?._id === kid) {
      if (!confirmLatest) {
        throw new ConvexError({
          code: "CONFIRMATION_REQUIRED",
          message: "Clé active : relancer avec confirmLatest=true (une nouvelle clé sera créée d'abord).",
        })
      }
      // Retour arrière : si une clé plus ancienne existe, elle redeviendra la
      // plus récente une fois la clé active retirée ; sinon, en créer une.
      if (keys.length === 1) replacement = await createSigningKey(ctx)
    }
    await deleteKey(ctx, kid)
    await audit(ctx, "jwks_key_revoked", { kid, replacement: replacement ?? null })
    return { revoked: kid, ...(replacement ? { replacement } : {}) }
  },
})

/** Tâche quotidienne : purge toujours, ne tourne que si la rotation est armée. */
export const tick = internalAction({
  args: {},
  returns: v.object({
    rotated: v.boolean(),
    reason: v.string(),
    pruned: v.array(v.string()),
    activeAgeDays: v.number(),
  }),
  handler: async (ctx) => {
    const now = Date.now()
    const keys = await readKeys(ctx)
    const plan = planKeyMaintenance(asRows(keys), now, {
      autoRotate: isAutoRotationEnabled(process.env.IDN_JWKS_AUTO_ROTATION),
    })
    // Aucune clé : Better Auth en créera une à la première signature ; la
    // tâche ne s'en charge pas (déploiement neuf, rien à faire tourner).
    let rotated = false
    if (plan.rotate && keys.length > 0) {
      const kid = await createSigningKey(ctx)
      await audit(ctx, "jwks_key_rotated", { kid, reason: plan.reason, previous: keys[0]!._id })
      rotated = true
    }
    for (const kid of plan.prune) {
      await deleteKey(ctx, kid)
      await audit(ctx, "jwks_key_pruned", { kid })
    }
    const activeAgeDays = keys[0] ? Math.floor((now - keys[0].createdAt) / DAY_MS) : 0
    if (!rotated) {
      console.info(`[jwks] clé active âgée de ${activeAgeDays} j (${plan.reason}), ${plan.prune.length} clé(s) purgée(s)`)
    }
    return { rotated, reason: plan.reason, pruned: plan.prune, activeAgeDays }
  },
})
