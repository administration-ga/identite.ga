import type { Doc } from "../_generated/dataModel"
import type { MutationCtx, QueryCtx } from "../_generated/server"
import { authComponent } from "../auth"

/**
 * Accès partagés aux tables de la confirmation de connexion. Lectures bornées
 * (guidelines Convex : pas de `collect()` sans borne) et filtrage des
 * révocations en mémoire, sur des lots courts.
 */

type Ctx = QueryCtx | MutationCtx

/** Appareils actifs (non révoqués) d'un utilisateur, bornés. */
export async function activeDevicesOf(
  ctx: Ctx,
  userId: string,
): Promise<Doc<"authenticatorDevice">[]> {
  const rows = await ctx.db
    .query("authenticatorDevice")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .take(50)
  return rows.filter((row) => row.revokedAt === undefined)
}

/** Lien actif (non révoqué) entre un utilisateur et un partenaire. */
export async function activeLinkOf(
  ctx: Ctx,
  userId: string,
  clientId: string,
): Promise<Doc<"partnerMfaLink"> | null> {
  const row = await ctx.db
    .query("partnerMfaLink")
    .withIndex("by_userId_and_clientId", (q) =>
      q.eq("userId", userId).eq("clientId", clientId),
    )
    .unique()
  return row && row.revokedAt === undefined ? row : null
}

/**
 * Le sujet OIDC (`sub`) désigne un utilisateur Better Auth existant ?
 * Renvoie son identifiant, ou null.
 */
export async function findSubject(ctx: Ctx, sub: string): Promise<string | null> {
  // Un `sub` mal formé fait lever le composant (« Unable to decode ID ») :
  // c'est un sujet inconnu, pas une erreur serveur.
  try {
    const user = await authComponent.getAnyUserById(ctx, sub)
    return user ? user._id : null
  } catch {
    return null
  }
}

/**
 * Annule les demandes encore en attente d'un couple (utilisateur, partenaire) :
 * appelé quand le lien est révoqué, pour qu'aucune demande ne survive au lien.
 */
export async function cancelPendingRequests(
  ctx: MutationCtx,
  userId: string,
  clientId: string,
  now: number,
): Promise<void> {
  const pending = await ctx.db
    .query("partnerMfaRequest")
    .withIndex("by_userId_and_status", (q) =>
      q.eq("userId", userId).eq("status", "pending"),
    )
    // Les plus récentes d'abord : les demandes encore valables sont les
    // dernières créées, derrière d'éventuelles demandes ignorées et échues.
    .order("desc")
    .take(50)
  for (const request of pending) {
    if (request.clientId !== clientId) continue
    await ctx.db.patch(request._id, { status: "cancelled", decidedAt: now })
  }
}
