/**
 * Règles pures du contrat IDN-ATTESTATION-NIVEAU-V1 (ADR 0003) : lecture
 * stricte des corps HTTP, décision d'attestation, décision de retrait,
 * comparaison de l'état civil verrouillé.
 *
 * Doctrine : le partenaire ATTESTE un fait (« ce sujet IDN est un ressortissant
 * gabonais dont l'inscription consulaire est déposée ») ; IDN seul DÉCIDE et
 * ÉCRIT `userProfile.loa`. Une attestation ne fait jamais baisser un niveau,
 * et un retrait ne redescend qu'au niveau constaté avant l'attestation, et
 * seulement si c'est l'attestation qui avait monté le compte.
 *
 * Aucune dépendance Convex ici : tout est testable directement (même
 * convention que `partnerMfa/rules.ts`).
 */

export const ATTESTATION_KINDS = ["consular_registration"] as const
export type AttestationKind = (typeof ATTESTATION_KINDS)[number]

export type Loa = 1 | 2 | 3

export const LIMITS = { sub: 128 } as const

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string }

export type LevelRequestInput = {
  sub: string
  kind: AttestationKind
  dryRun: boolean
}

function plainObject(body: unknown): Record<string, unknown> | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null
  }
  return body as Record<string, unknown>
}

/** Refuse les clés hors liste blanche : une faute de frappe ne doit pas passer. */
function unknownKeyMessage(
  object: Record<string, unknown>,
  allowed: readonly string[],
): string | null {
  const unknown = Object.keys(object).find((key) => !allowed.includes(key))
  return unknown ? `Champ inconnu « ${unknown} ».` : null
}

/** Même forme pour l'attestation et pour le retrait : `{ sub, kind, dryRun? }`. */
function parseLevelBody(body: unknown): Parsed<LevelRequestInput> {
  const object = plainObject(body)
  if (!object) return { ok: false, message: "Corps JSON attendu." }
  const unknown = unknownKeyMessage(object, ["sub", "kind", "dryRun"])
  if (unknown) return { ok: false, message: unknown }

  const sub = typeof object.sub === "string" ? object.sub.trim() : ""
  if (sub.length === 0 || sub.length > LIMITS.sub) {
    return { ok: false, message: "« sub » est requis." }
  }
  if (!ATTESTATION_KINDS.includes(object.kind as AttestationKind)) {
    return { ok: false, message: "« kind » doit valoir consular_registration." }
  }
  if (object.dryRun !== undefined && typeof object.dryRun !== "boolean") {
    return { ok: false, message: "« dryRun » doit être un booléen." }
  }
  return {
    ok: true,
    value: {
      sub,
      kind: object.kind as AttestationKind,
      dryRun: object.dryRun === true,
    },
  }
}

export function parseAttestBody(body: unknown): Parsed<LevelRequestInput> {
  return parseLevelBody(body)
}

export function parseWithdrawBody(body: unknown): Parsed<LevelRequestInput> {
  return parseLevelBody(body)
}

/** Même correspondance que `loaToAcr` (http.ts) et `userinfoClaims.ts`. */
export function acrFor(loa: Loa): "eidas1" | "eidas2" | "eidas3" {
  return loa === 3 ? "eidas3" : loa === 2 ? "eidas2" : "eidas1"
}

export type CivilStatus = {
  firstName: string
  lastName: string
  dateOfBirth: string
  nationality: string
}

/**
 * Un profil est complet pour une attestation quand les quatre éléments qui
 * identifient la personne sont renseignés : nom, prénom, date de naissance
 * ISO et nationalité. Ce sont aussi ceux que l'attestation verrouille.
 */
export function isPivotComplete(
  pivot: Partial<CivilStatus> | undefined | null,
): boolean {
  if (!pivot) return false
  const filled = (value: string | undefined) =>
    typeof value === "string" && value.trim().length > 0
  return (
    filled(pivot.firstName) &&
    filled(pivot.lastName) &&
    filled(pivot.nationality) &&
    typeof pivot.dateOfBirth === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(pivot.dateOfBirth.trim())
  )
}

/**
 * Normalisation appliquée par `profile.updatePivot` avant d'écrire : noms
 * rognés, nationalité rognée en majuscules, date telle quelle. On l'applique
 * aux deux côtés pour qu'un enregistrement sans changement soit reconnu comme
 * tel, même sur un profil historique mal rogné.
 */
function normalizeCivilStatus(value: CivilStatus): CivilStatus {
  return {
    firstName: value.firstName.trim(),
    lastName: value.lastName.trim(),
    dateOfBirth: value.dateOfBirth.trim(),
    nationality: value.nationality.trim().toUpperCase(),
  }
}

const CIVIL_STATUS_FIELDS = [
  "firstName",
  "lastName",
  "dateOfBirth",
  "nationality",
] as const

/** Champs verrouillés que la nouvelle saisie modifierait réellement. */
export function changedCivilStatusFields(
  current: CivilStatus | undefined | null,
  next: CivilStatus,
): Array<(typeof CIVIL_STATUS_FIELDS)[number]> {
  if (!current) return [...CIVIL_STATUS_FIELDS]
  const before = normalizeCivilStatus(current)
  const after = normalizeCivilStatus(next)
  return CIVIL_STATUS_FIELDS.filter((field) => before[field] !== after[field])
}

// ---------------------------------------------------------------------------
// Attestation
// ---------------------------------------------------------------------------

export type AttestationFacts = {
  /** Niveau courant du compte. */
  loa: Loa
  profileType: string
  /** Cf. `isPivotComplete`. */
  pivotComplete: boolean
  /** Suppression du compte demandée ou programmée. */
  closing: boolean
  /** Statut de la DERNIÈRE demande KYC du compte, s'il en existe une. */
  latestKycStatus: string | null
  /** Un signalement de doublon ouvert porte sur ce compte. */
  openDuplicateFlag: boolean
  /** Attestation déjà active pour ce couple (client, sujet, type). */
  activeAttestation: { attestedAt: number } | null
  /** Plafond accordé au client par sa capacité. */
  maxLoa: 2
}

export type NotEligibleReason =
  | "profile_type"
  | "account_closing"
  | "profile_incomplete"
export type ReviewRequiredReason = "kyc_rejected" | "duplicate_flag_open"

export type AttestationDecision =
  | { ok: true; outcome: "already_attested"; loa: Loa; attestedAt: number }
  | { ok: true; outcome: "applied"; loa: Loa; previousLoa: Loa; raised: true }
  | { ok: true; outcome: "recorded"; loa: Loa; previousLoa: Loa; raised: false }
  | { ok: false; error: "not_eligible"; reason: NotEligibleReason }
  | { ok: false; error: "review_required"; reason: ReviewRequiredReason }

/**
 * Décide l'effet d'une attestation. Ordre :
 *   1. attestation déjà active → rien à faire (idempotence, rejeu réseau) ;
 *   2. éligibilité : citoyen seulement, compte qui ne se ferme pas, profil
 *      complet ;
 *   3. revue humaine : dernière demande KYC refusée (un refus de contrôleur ne
 *      se contourne pas par une attestation), doublon ouvert ;
 *   4. niveau : le Niveau 1 monte au plafond ; un Niveau 2 ou 3 acquis par
 *      une autre voie est seulement tracé, jamais abaissé.
 */
export function decideAttestation(facts: AttestationFacts): AttestationDecision {
  if (facts.activeAttestation) {
    return {
      ok: true,
      outcome: "already_attested",
      loa: facts.loa,
      attestedAt: facts.activeAttestation.attestedAt,
    }
  }
  if (facts.profileType !== "citizen") {
    return { ok: false, error: "not_eligible", reason: "profile_type" }
  }
  if (facts.closing) {
    return { ok: false, error: "not_eligible", reason: "account_closing" }
  }
  if (!facts.pivotComplete) {
    return { ok: false, error: "not_eligible", reason: "profile_incomplete" }
  }
  if (facts.latestKycStatus === "rejected") {
    return { ok: false, error: "review_required", reason: "kyc_rejected" }
  }
  if (facts.openDuplicateFlag) {
    return { ok: false, error: "review_required", reason: "duplicate_flag_open" }
  }
  if (facts.loa < facts.maxLoa) {
    return {
      ok: true,
      outcome: "applied",
      loa: facts.maxLoa,
      previousLoa: facts.loa,
      raised: true,
    }
  }
  return {
    ok: true,
    outcome: "recorded",
    loa: facts.loa,
    previousLoa: facts.loa,
    raised: false,
  }
}

// ---------------------------------------------------------------------------
// Retrait
// ---------------------------------------------------------------------------

export type WithdrawalFacts = {
  /** Attestation ACTIVE de ce couple (client, sujet, type), sinon null. */
  attestation: { previousLoa: Loa; raised: boolean } | null
  loa: Loa
  /** Le compte a au moins une demande KYC approuvée (pièces examinées). */
  hasApprovedKyc: boolean
  /** Attestations actives d'AUTRES clients pour ce compte. */
  otherActiveAttestations: number
}

export type WithdrawalDecision =
  | { outcome: "not_attested"; loa: Loa }
  | { outcome: "kept"; loa: Loa; transferRaise: boolean }
  | { outcome: "withdrawn"; loa: Loa }

/**
 * Décide l'effet d'un retrait. Le niveau ne redescend que si TOUT ceci tient :
 * l'attestation avait monté le compte, aucune demande KYC n'a été approuvée
 * depuis, le compte n'est pas au Niveau 3, et aucune autre attestation active
 * ne soutient le niveau.
 *
 * `transferRaise` : une autre attestation active garde le niveau ; elle hérite
 * alors de la charge de l'avoir monté, pour que SON retrait puisse le faire
 * redescendre plus tard. Sans ce transfert, un compte resterait au Niveau 2
 * sans attestation ni pièce examinée, et passerait pour une preuve
 * documentaire.
 */
export function decideWithdrawal(facts: WithdrawalFacts): WithdrawalDecision {
  if (!facts.attestation) return { outcome: "not_attested", loa: facts.loa }
  if (!facts.attestation.raised || facts.hasApprovedKyc || facts.loa >= 3) {
    return { outcome: "kept", loa: facts.loa, transferRaise: false }
  }
  if (facts.otherActiveAttestations > 0) {
    return { outcome: "kept", loa: facts.loa, transferRaise: true }
  }
  const restored = Math.min(facts.loa, facts.attestation.previousLoa) as Loa
  return { outcome: "withdrawn", loa: restored }
}
