import { APIError } from "better-auth/api"

/**
 * Niveau de garantie (eIDAS faible, substantiel, élevé) à l'émission des
 * jetons — CH-820, ADR 0002.
 *
 * - Le niveau du compte part TOUJOURS dans `acr` (eidas1..3, « 0 » sans
 *   profil) et `loa`, quels que soient les scopes : l'application vérifie
 *   elle-même le niveau qu'elle a demandé en `acr_values` (SDK `minLevel`).
 * - Un client STRICT (`metadata.loaEnforcement: "strict"`, posé par
 *   `bootstrapTrustedClient` pour les applications de l'État) n'obtient
 *   aucun jeton ni claim sous son minimum `metadata.loa`. Les autres clients
 *   gardent le comportement publié (docs/verification-api.md) : jeton émis au
 *   niveau réel, revue manuelle suivie par l'application.
 *
 * L'écran de consentement ne suffisait pas : Better Auth rend le code sans
 * écran à un client déjà consenti, et l'échange partenaire n'a pas d'écran.
 */

export type AssuranceLevel = 1 | 2 | 3

const ACR_FOR_LEVEL: Record<0 | AssuranceLevel, string> = {
  // Valeur OIDC Core §2 : « ne satisfait pas le niveau 1 ».
  0: "0",
  1: "eidas1",
  2: "eidas2",
  3: "eidas3",
}

export const acrForLevel = (level: 0 | AssuranceLevel): string => ACR_FOR_LEVEL[level]

const isLevel = (value: unknown): value is AssuranceLevel =>
  value === 1 || value === 2 || value === 3

export type ClientLevelPolicy = {
  /** Refus à l'émission sous `minimum` (applications de l'État). */
  strict: boolean
  /** Minimum déclaré (`metadata.loa`) ; plancher 3 si illisible et strict. */
  minimum: AssuranceLevel
}

const parseMetadata = (metadata: unknown): Record<string, unknown> => {
  if (typeof metadata === "string") {
    try {
      const parsed = JSON.parse(metadata) as unknown
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
  return metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>) : {}
}

export function clientLevelPolicy(metadata: unknown): ClientLevelPolicy {
  const meta = parseMetadata(metadata)
  const strict = meta.loaEnforcement === "strict"
  const minimum = isLevel(meta.loa) ? meta.loa : strict ? 3 : 1
  return { strict, minimum }
}

/** Niveau du compte tel que stocké dans `userProfile.loa` ; 0 sans profil. */
export function accountLevel(profile: { loa?: unknown } | null | undefined): 0 | AssuranceLevel {
  return profile && isLevel(profile.loa) ? profile.loa : 0
}

/**
 * Refus OAuth quand le compte n'atteint pas le niveau exigé. `access_denied`
 * (RFC 6749 §5.2 / OIDC Core §3.1.2.6) avec la raison normalisée par
 * « OpenID Connect Unmet Authentication Requirements » dans la description.
 */
export function assertAssuranceLevel(actual: 0 | AssuranceLevel, required: AssuranceLevel): void {
  if (actual >= required) return
  throw new APIError("FORBIDDEN", {
    error: "access_denied",
    error_description: `unmet_authentication_requirements: ${acrForLevel(required)} requis`,
  })
}

/** Usager hors de la liste de test d'un client bac à sable. */
export function sandboxAccessDenied(): never {
  throw new APIError("FORBIDDEN", {
    error: "access_denied",
    error_description: "sandbox_access_denied: compte absent de la liste de test de l'application",
  })
}
