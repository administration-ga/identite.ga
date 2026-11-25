import { ConvexError } from "convex/values"

import type { QueryCtx } from "../_generated/server"
import { normalizeNipKey } from "../lib/identity"
import { changedCivilStatusFields, type CivilStatus } from "./rules"
import { activeAttestationsOf } from "./store"

/**
 * Verrou de l'état civil attesté (ADR 0003, décision 6).
 *
 * Tant qu'une attestation est ACTIVE, le partenaire répond de l'identité qu'il
 * a constatée : nom, prénoms, date de naissance, nationalité et NIP ne se
 * modifient plus depuis l'espace de la personne. Sans ce verrou, un compte
 * monté au Niveau 2 par l'attestation pourrait ensuite changer d'identité en
 * gardant son niveau. Le genre et le lieu de naissance restent modifiables.
 *
 * INERTE pour tout compte sans attestation active, y compris un Niveau 2 ou 3
 * obtenu par KYC (périmètre fixé par la session parente le 25/11/2026). Aucune
 * lecture en base tant qu'aucun champ verrouillé ne change réellement.
 */

const LOCKED_CIVIL_STATUS_MESSAGE =
  "Votre identité a été attestée par votre inscription consulaire : vos nom, prénoms, date de naissance et nationalité ne peuvent pas être modifiés ici. Pour corriger une erreur, adressez-vous à votre consulat ou au support d'identite.ga."

const LOCKED_NIP_MESSAGE =
  "Votre identité a été attestée par votre inscription consulaire : votre NIP ne peut être ni remplacé ni retiré ici. Pour corriger une erreur, adressez-vous à votre consulat ou au support d'identite.ga."

async function hasActiveAttestation(
  ctx: { db: QueryCtx["db"] },
  userId: string,
): Promise<boolean> {
  return (await activeAttestationsOf(ctx, userId)).length > 0
}

/**
 * Refuse une modification des champs verrouillés sous attestation active.
 * Une saisie identique (après les mêmes rognages que l'écriture) passe.
 */
export async function assertCivilStatusEditable(
  ctx: { db: QueryCtx["db"] },
  userId: string,
  current: CivilStatus | undefined,
  next: CivilStatus,
): Promise<void> {
  if (changedCivilStatusFields(current, next).length === 0) return
  if (!(await hasActiveAttestation(ctx, userId))) return
  throw new ConvexError({
    code: "IDENTITY_LOCKED",
    message: LOCKED_CIVIL_STATUS_MESSAGE,
  })
}

/**
 * Refuse de remplacer ou de retirer un NIP existant sous attestation active.
 * Ajouter un premier NIP, ou ressaisir le même, reste permis.
 */
export async function assertNipReplaceable(
  ctx: { db: QueryCtx["db"] },
  userId: string,
  currentNip: string | undefined,
  nextNip: string | undefined,
): Promise<void> {
  const current = normalizeNipKey(currentNip)
  if (!current) return
  if (normalizeNipKey(nextNip) === current) return
  if (!(await hasActiveAttestation(ctx, userId))) return
  throw new ConvexError({ code: "IDENTITY_LOCKED", message: LOCKED_NIP_MESSAGE })
}
