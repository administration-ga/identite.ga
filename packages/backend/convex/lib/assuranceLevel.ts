import { APIError } from "better-auth/api"

/**
 * Niveau de garantie (eIDAS faible, substantiel, élevé) contrôlé à l'émission
 * des jetons — CH-820.
 *
 * L'écran de consentement affichait déjà « niveau trop bas », mais Better Auth
 * émet le code sans écran pour un client déjà consenti, et l'échange partenaire
 * n'a pas d'écran du tout : le contrôle vit donc ici, au moment où un jeton ou
 * des claims sortent d'IDN, et le niveau part dans la revendication `acr`.
 */

export type AssuranceLevel = 1 | 2 | 3

const ACR_FOR_LEVEL: Record<AssuranceLevel, string> = {
  1: "eidas1",
  2: "eidas2",
  3: "eidas3",
}

const LEVEL_FOR_ACR: Record<string, AssuranceLevel> = {
  eidas1: 1,
  eidas2: 2,
  eidas3: 3,
}

export const acrForLevel = (level: AssuranceLevel): string => ACR_FOR_LEVEL[level]

const isLevel = (value: unknown): value is AssuranceLevel =>
  value === 1 || value === 2 || value === 3

/**
 * Niveau exigé par `acr_values` (liste OIDC séparée par des espaces, valeurs
 * acceptables par ordre de préférence) : le plus bas des niveaux reconnus,
 * puisque chacun d'eux satisfait la demande. 0 si rien n'est reconnu.
 */
export function levelRequestedByAcrValues(raw: unknown): 0 | AssuranceLevel {
  if (typeof raw !== "string") return 0
  const levels = raw
    .split(/\s+/)
    .map((value) => LEVEL_FOR_ACR[value])
    .filter(isLevel)
  return levels.length > 0 ? (Math.min(...levels) as AssuranceLevel) : 0
}

/** Minimum déclaré par le client (`metadata.loa` du portail), 1 par défaut. */
export function clientMinimumLevel(metadata: unknown): AssuranceLevel {
  const raw =
    typeof metadata === "string"
      ? (() => {
          try {
            return JSON.parse(metadata) as unknown
          } catch {
            return null
          }
        })()
      : metadata
  const loa = raw && typeof raw === "object" ? (raw as { loa?: unknown }).loa : undefined
  return isLevel(loa) ? loa : 1
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
