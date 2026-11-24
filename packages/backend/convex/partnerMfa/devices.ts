import { ConvexError, v } from "convex/values"

import { internal } from "../_generated/api"
import { mutation, query } from "../_generated/server"
import { requireAuth } from "../lib/auth"
import { generateTotpSecret } from "./totpCore"
import { sealDeviceSecret } from "./secretBox"
import { LIMITS, MAX_ACTIVE_DEVICES } from "./rules"
import { activeDevicesOf } from "./store"

/**
 * Appareils de confiance : une installation de l'app identite.ga = un appareil,
 * avec son secret TOTP. Ces fonctions sont appelées par l'app, en session.
 *
 * Le secret n'est renvoyé en clair qu'à la création et à la rotation. Il est
 * ensuite rangé dans le SecureStore du téléphone ; le serveur ne peut plus le
 * relire en clair (il ne garde que la version chiffrée).
 */

const platformValidator = v.union(v.literal("ios"), v.literal("android"))

const deviceView = v.object({
  deviceId: v.id("authenticatorDevice"),
  installationId: v.string(),
  name: v.string(),
  platform: platformValidator,
  createdAt: v.number(),
  lastSeenAt: v.number(),
})

function cleanInstallationId(raw: string): string {
  const value = raw.trim()
  if (value.length < 8 || value.length > LIMITS.installationId) {
    throw new ConvexError({
      code: "INVALID_INSTALLATION_ID",
      message: "Identifiant d'installation invalide.",
    })
  }
  return value
}

function cleanDeviceName(raw: string): string {
  const value = raw.trim()
  if (value.length === 0) return "Appareil"
  return value.slice(0, LIMITS.deviceName)
}

export const registerDevice = mutation({
  args: {
    installationId: v.string(),
    name: v.string(),
    platform: platformValidator,
  },
  returns: v.object({
    created: v.boolean(),
    deviceId: v.id("authenticatorDevice"),
    /** Présent uniquement à la création : le secret ne sort plus ensuite. */
    secret: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const user = await requireAuth(ctx)
    const installationId = cleanInstallationId(args.installationId)
    const name = cleanDeviceName(args.name)
    const now = Date.now()

    const active = await activeDevicesOf(ctx, user.userId)
    const existing = active.find((d) => d.installationId === installationId)
    if (existing) {
      await ctx.db.patch(existing._id, { name, lastSeenAt: now })
      return { created: false, deviceId: existing._id, secret: null }
    }
    if (active.length >= MAX_ACTIVE_DEVICES) {
      throw new ConvexError({
        code: "TOO_MANY_DEVICES",
        message: `Au plus ${MAX_ACTIVE_DEVICES} appareils de confiance. Retirez-en un avant d'en ajouter.`,
      })
    }

    const secret = generateTotpSecret()
    const deviceId = await ctx.db.insert("authenticatorDevice", {
      userId: user.userId,
      installationId,
      name,
      platform: args.platform,
      secret: await sealDeviceSecret(secret),
      createdAt: now,
      lastSeenAt: now,
    })
    await ctx.runMutation(internal.audit.recordAudit, {
      actorId: user.userId,
      action: "partner_mfa_device_registered",
      targetType: "user",
      targetId: user.userId,
      metadata: { deviceId, platform: args.platform },
    })
    return { created: true, deviceId, secret }
  },
})

export const rotateDevice = mutation({
  args: { installationId: v.string() },
  returns: v.object({
    deviceId: v.id("authenticatorDevice"),
    secret: v.string(),
  }),
  handler: async (ctx, args) => {
    const user = await requireAuth(ctx)
    const installationId = cleanInstallationId(args.installationId)
    const device = (await activeDevicesOf(ctx, user.userId)).find(
      (d) => d.installationId === installationId,
    )
    if (!device) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Appareil introuvable.",
      })
    }
    const secret = generateTotpSecret()
    // Un nouveau secret repart de zéro : l'ancien compteur ne s'applique plus.
    await ctx.db.patch(device._id, {
      secret: await sealDeviceSecret(secret),
      lastTotpCounter: undefined,
      lastSeenAt: Date.now(),
    })
    await ctx.runMutation(internal.audit.recordAudit, {
      actorId: user.userId,
      action: "partner_mfa_device_registered",
      targetType: "user",
      targetId: user.userId,
      metadata: { deviceId: device._id, rotated: true },
    })
    return { deviceId: device._id, secret }
  },
})

export const myDevices = query({
  args: {},
  returns: v.array(deviceView),
  handler: async (ctx) => {
    const user = await requireAuth(ctx)
    const devices = await activeDevicesOf(ctx, user.userId)
    return devices
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((device) => ({
        deviceId: device._id,
        installationId: device.installationId,
        name: device.name,
        platform: device.platform,
        createdAt: device.createdAt,
        lastSeenAt: device.lastSeenAt,
      }))
  },
})

export const revokeDevice = mutation({
  args: { deviceId: v.id("authenticatorDevice") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requireAuth(ctx)
    const device = await ctx.db.get(args.deviceId)
    if (!device || device.userId !== user.userId) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Appareil introuvable.",
      })
    }
    if (device.revokedAt !== undefined) return null
    await ctx.db.patch(device._id, { revokedAt: Date.now() })
    await ctx.runMutation(internal.audit.recordAudit, {
      actorId: user.userId,
      action: "partner_mfa_device_revoked",
      targetType: "user",
      targetId: user.userId,
      metadata: { deviceId: device._id },
    })
    return null
  },
})
