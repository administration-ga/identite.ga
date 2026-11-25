import type { QueryCtx } from "../_generated/server";
import { activeAttestationsOf, hasApprovedKyc } from "../partnerLevel/store";

/**
 * Niveau de PREUVE DOCUMENTAIRE d'un compte (ADR 0003).
 *
 * Jusqu'au 25/11/2026, un Niveau 2 ne s'obtenait que par des pièces examinées
 * (KYC) ou par délégation au guichet. Plusieurs règles en ont tiré que
 * `loa >= 2` voulait dire « pièces déjà examinées » : le raccourci vers le
 * Niveau 3 (pas de nouvelle piste documentaire), la décision de Niveau 3
 * (rien à constater), et le contrôle anti-doublon (un homonyme vérifié ferme
 * la porte).
 *
 * Le Niveau 2 attesté par un partenaire (`partnerLevel/`) ne porte pas cette
 * preuve : IDN n'a vu aucune pièce. Pour ces règles-là, un compte « attesté
 * seulement » — attestation ACTIVE qui a elle-même monté le compte, et aucune
 * demande KYC approuvée — compte comme un Niveau 1. Le niveau publié (`loa`,
 * `acr`) reste 2 ; seule la question « des pièces ont-elles été examinées ? »
 * change de réponse.
 *
 * INERTE pour tout compte sans attestation : la fonction rend le niveau réel,
 * sans autre lecture qu'un index vide quand `loa === 2`.
 */
export async function documentaryLoa(
  ctx: { db: QueryCtx["db"] },
  userId: string,
  loa: number,
): Promise<number> {
  if (loa !== 2) return loa;
  const attestations = await activeAttestationsOf(ctx, userId);
  if (!attestations.some((attestation) => attestation.raised)) return loa;
  if (await hasApprovedKyc(ctx, userId)) return loa;
  return 1;
}
