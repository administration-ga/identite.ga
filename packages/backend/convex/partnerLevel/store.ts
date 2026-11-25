import { components } from "../_generated/api"
import type { Doc } from "../_generated/dataModel"
import type { QueryCtx } from "../_generated/server"
import type { AttestationKind } from "./rules"

/**
 * Lectures partagées de l'attestation de niveau (contrat
 * IDN-ATTESTATION-NIVEAU-V1) : capacité d'un client, attestations d'un compte,
 * preuves qui comptent pour décider (KYC approuvé, doublon ouvert,
 * consentement). Toutes bornées et indexées.
 *
 * `DatabaseWriter` étend `DatabaseReader` : un ctx de mutation satisfait ces
 * signatures, d'où le type `{ db: QueryCtx["db"] }` (même idiome que
 * `verification/requestFlow.ts`).
 */

type Reader = { db: QueryCtx["db"] }

/** Capacité ACTIVE d'un client pour un type de fait, sinon null. */
export async function activeGrantOf(
  ctx: Reader,
  clientId: string,
  kind: AttestationKind,
): Promise<Doc<"partnerLevelGrant"> | null> {
  const row = await ctx.db
    .query("partnerLevelGrant")
    .withIndex("by_clientId_and_kind", (q) =>
      q.eq("clientId", clientId).eq("kind", kind),
    )
    .unique()
  return row && row.revokedAt === undefined ? row : null
}

/** La ligne du couple (client, type, sujet), active ou retirée. */
export async function attestationRowOf(
  ctx: Reader,
  clientId: string,
  kind: AttestationKind,
  userId: string,
): Promise<Doc<"levelAttestation"> | null> {
  return await ctx.db
    .query("levelAttestation")
    .withIndex("by_clientId_and_kind_and_userId", (q) =>
      q.eq("clientId", clientId).eq("kind", kind).eq("userId", userId),
    )
    .unique()
}

/**
 * Attestations ACTIVES d'un compte, tous clients confondus. Une ligne par
 * couple (client, type) : le volume par compte est borné par le nombre de
 * partenaires habilités.
 */
export async function activeAttestationsOf(
  ctx: Reader,
  userId: string,
): Promise<Doc<"levelAttestation">[]> {
  const rows = await ctx.db
    .query("levelAttestation")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .take(20)
  return rows.filter((row) => row.status === "active")
}

/** Le compte a-t-il au moins une demande KYC approuvée (pièces examinées) ? */
export async function hasApprovedKyc(ctx: Reader, userId: string): Promise<boolean> {
  const approved = await ctx.db
    .query("kycRequest")
    .withIndex("by_userId_status", (q) =>
      q.eq("userId", userId).eq("status", "approved"),
    )
    .first()
  return approved !== null
}

/**
 * Un signalement de doublon OUVERT porte-t-il sur ce compte ? Seuls les
 * signaux levés sur le compte lui-même comptent (`userId`) : compter aussi
 * ceux qui le désignent comme « compte en regard » permettrait à quiconque
 * s'inscrit sous son nom de bloquer son attestation.
 */
export async function hasOpenDuplicateFlag(
  ctx: Reader,
  userId: string,
): Promise<boolean> {
  const open = await ctx.db
    .query("duplicateSignal")
    .withIndex("by_userId_status", (q) =>
      q.eq("userId", userId).eq("status", "open"),
    )
    .first()
  return open !== null
}

type ConsentRow = {
  clientId?: string | null
  consentGiven?: boolean | null
}

/**
 * Consentement enregistré de ce sujet pour ce client (table `oauthConsent` du
 * composant Better Auth). Même lecture que `oauthConsents.grant` et que
 * l'échange partenaire (`lib/partnerTokenExchange.ts`) : index `userId`, puis
 * filtre en mémoire ; un consentement retiré (`consentGiven: false`) ne compte
 * pas.
 */
export async function hasRecordedConsent(
  ctx: Pick<QueryCtx, "runQuery">,
  userId: string,
  clientId: string,
): Promise<boolean> {
  const raw = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
    model: "oauthConsent",
    where: [{ field: "userId", value: userId, operator: "eq" }],
    paginationOpts: { numItems: 200, cursor: null },
  })) as { page: ConsentRow[] }
  return raw.page.some(
    (consent) => consent.clientId === clientId && consent.consentGiven !== false,
  )
}
