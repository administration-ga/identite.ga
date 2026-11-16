import { v } from "convex/values"

import { internalMutation } from "../_generated/server"
import { rateLimiter } from "../rateLimiter"
import { openDeviceSecret } from "./secretBox"
import { activeDevicesOf, activeLinkOf, findSubject } from "./store"
import { matchingCounter } from "./totpCore"

/**
 * `POST /partner-mfa/v1/totp/verify` : le partenaire vérifie un code affiché par
 * l'app (« Codes de connexion »), hors réseau côté citoyen.
 *
 * Mutation et non query : elle consomme le quota de tentatives et met à jour le
 * dernier pas accepté de l'appareil. Les deux écritures sont dans la même
 * transaction, donc deux vérifications simultanées du même code ne passent pas
 * toutes les deux.
 */
export const verifyCode = internalMutation({
  args: {
    clientId: v.string(),
    sub: v.string(),
    code: v.string(),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), valid: v.boolean() }),
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
    const limit = await rateLimiter.limit(ctx, "partnerMfaTotpVerify", {
      key: `${args.clientId}:${args.sub}`,
      throws: false,
    })
    if (!limit.ok) return { ok: false as const, error: "rate_limited" as const }

    const userId = await findSubject(ctx, args.sub)
    if (!userId) return { ok: false as const, error: "unknown_subject" as const }

    const link = await activeLinkOf(ctx, userId, args.clientId)
    if (!link) return { ok: false as const, error: "not_linked" as const }

    const devices = await activeDevicesOf(ctx, userId)
    if (devices.length === 0) return { ok: false as const, error: "no_device" as const }

    const now = Date.now()
    for (const device of devices) {
      const secret = await openDeviceSecret(device.secret)
      const counter = await matchingCounter(secret, args.code, now)
      if (counter === null) continue
      // Anti-rejeu : un pas déjà consommé ne redonne jamais valid:true.
      if (device.lastTotpCounter !== undefined && counter <= device.lastTotpCounter) {
        continue
      }
      await ctx.db.patch(device._id, { lastTotpCounter: counter, lastSeenAt: now })
      return { ok: true as const, valid: true }
    }
    return { ok: true as const, valid: false }
  },
})
