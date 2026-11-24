/**
 * Règle de rotation des clés de signature d'IDN — fonction pure (CH-820,
 * ADR 0002). Les actions de `convex/jwksRotation.ts` l'appliquent.
 *
 * Better Auth signe toujours avec la clé la plus récente (`createdAt`) : une
 * rotation crée une clé, qui signe aussitôt ; l'ancienne reste publiée dans
 * le JWKS le temps que les jetons qu'elle a signés expirent (1 h pour les ID
 * tokens et jetons d'accès, 15 min pour les JWT Convex), puis est purgée.
 */

export const DAY_MS = 24 * 60 * 60 * 1000

export const ROTATION_POLICY = {
  /** Âge de la clé active au-delà duquel la rotation automatique la remplace. */
  rotationIntervalMs: 90 * DAY_MS,
  /** Publication d'une clé remplacée, comptée depuis la création de sa remplaçante. */
  overlapMs: 7 * DAY_MS,
  /** Écart minimal entre deux rotations, sauf rotation forcée. */
  minRotationGapMs: 7 * DAY_MS,
} as const

export type RotationPolicy = typeof ROTATION_POLICY

export type KeyRow = { id: string; createdAt: number }

export type MaintenancePlan = {
  /** Créer une nouvelle clé (qui devient la clé de signature). */
  rotate: boolean
  /** Clés à retirer du JWKS (jamais la plus récente). */
  prune: string[]
  /** Pourquoi la rotation est faite ou non, pour le journal. */
  reason:
    | "no_key"
    | "forced"
    | "due"
    | "not_due"
    | "auto_rotation_disabled"
    | "too_soon"
}

const newestFirst = (keys: readonly KeyRow[]): KeyRow[] =>
  [...keys].sort((a, b) => b.createdAt - a.createdAt)

/**
 * Plan de maintenance des clés à l'instant `now`.
 *
 * - aucune clé : en créer une ;
 * - `force` (geste de l'opérateur) : rotation immédiate ;
 * - sinon jamais moins de `minRotationGapMs` après la précédente, et
 *   seulement si `autoRotate` et clé active plus vieille que
 *   `rotationIntervalMs` ;
 * - purge : une clé non active dont la remplaçante (la clé immédiatement plus
 *   récente) existe depuis plus de `overlapMs`. La clé la plus récente n'est
 *   jamais purgée : le JWKS n'est jamais vide.
 */
export function planKeyMaintenance(
  keys: readonly KeyRow[],
  now: number,
  opts: {
    autoRotate: boolean
    force?: boolean
    policy?: RotationPolicy
  },
): MaintenancePlan {
  const policy = opts.policy ?? ROTATION_POLICY
  const ordered = newestFirst(keys)
  const latest = ordered[0]

  const prune: string[] = []
  for (let i = 1; i < ordered.length; i++) {
    const replacement = ordered[i - 1]!
    if (now - replacement.createdAt >= policy.overlapMs) prune.push(ordered[i]!.id)
  }

  if (!latest) return { rotate: true, prune, reason: "no_key" }
  if (opts.force) return { rotate: true, prune, reason: "forced" }
  const age = now - latest.createdAt
  if (age < policy.minRotationGapMs) return { rotate: false, prune, reason: "too_soon" }
  if (!opts.autoRotate) return { rotate: false, prune, reason: "auto_rotation_disabled" }
  if (age >= policy.rotationIntervalMs) return { rotate: true, prune, reason: "due" }
  return { rotate: false, prune, reason: "not_due" }
}

/** Interrupteur de la rotation automatique, posé par le propriétaire. */
export const isAutoRotationEnabled = (raw: string | undefined): boolean =>
  (raw ?? "").trim().toLowerCase() === "enabled"
