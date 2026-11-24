import { ConvexError, v } from "convex/values"
import { components } from "../_generated/api"
import { internalMutation } from "../_generated/server"
import { findBetterAuthUserByEmail } from "../lib/incompleteSignup"
import { generateIdnId } from "../lib/idnId"
import { derivePivotKeys } from "../lib/identity"
import { derivePinHash, PIN_REGEX } from "../lib/pin"

/** Admin-only provisioning for the explicitly authorized Apple review account.
 * Credentials are supplied privately, never committed. No roles or KYC approval.
 */
export const create = internalMutation({
  args: { pin: v.string() },
  returns: v.object({ email: v.string(), userId: v.string() }),
  handler: async (ctx, { pin }) => {
    if (!PIN_REGEX.test(pin)) throw new ConvexError("PIN à six chiffres requis.")
    const email = "apple.review@idn.ga"
    if (await findBetterAuthUserByEmail(ctx, email)) {
      throw new ConvexError("Le compte existe déjà ; aucune modification effectuée.")
    }
    const now = Date.now()
    const user = await ctx.runMutation(components.betterAuth.adapter.create, {
      input: { model: "user", data: {
        email, name: "Démonstration Apple", emailVerified: true,
        createdAt: now, updatedAt: now,
      } },
    }) as { _id: string }
    const pivot = {
      firstName: "Démonstration", lastName: "Apple", dateOfBirth: "1990-01-01",
      gender: "N" as const, birthPlace: "Libreville", nationality: "GA",
    }
    await ctx.db.insert("userProfile", {
      userId: user._id, profileType: "citizen", loa: 1,
      idnId: await generateIdnId(ctx), pivot, ...derivePivotKeys(pivot),
      pinHash: await derivePinHash(pin, user._id), createdAt: now, updatedAt: now,
    })
    await ctx.db.insert("auditLog", {
      actorId: "system", action: "admin_action", targetType: "user", targetId: user._id,
      metadata: { kind: "apple_review_demo_created", synthetic: true }, createdAt: now,
    })
    return { email, userId: user._id }
  },
})
