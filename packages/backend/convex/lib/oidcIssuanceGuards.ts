import { APIError, isAPIError } from "better-auth/api"

import { levelRequestedByAcrValues, type AssuranceLevel } from "./assuranceLevel"

/**
 * Gardes du fournisseur OIDC posées en hooks Better Auth (CH-820).
 *
 * 1. `/oauth2/register` fermé : les clients naissent au portail développeur
 *    (bac à sable) et passent en production par l'approbation d'un
 *    administrateur. La route de Better Auth acceptait toute session et
 *    laissait le demandeur écrire `metadata` (donc `env: "production"`).
 * 2. Le niveau demandé par `acr_values` à l'autorisation est attaché au code
 *    d'autorisation, puis relu à l'échange du code : l'émission du jeton le
 *    contrôle même quand aucun écran de consentement n'a été affiché.
 */

export const DYNAMIC_REGISTRATION_PATH = "/oauth2/register"
export const AUTHORIZE_PATH = "/oauth2/authorize"
export const TOKEN_PATH = "/oauth2/token"

/** Champ ajouté à la valeur de vérification du code par IDN. */
export const REQUIRED_LEVEL_FIELD = "idnRequiredLevel"

export function refuseDynamicRegistration(): never {
  throw new APIError("FORBIDDEN", {
    error: "access_denied",
    error_description:
      "client_registration_closed: les clients se créent au portail développeur d'identite.ga",
  })
}

/** URL de redirection portée par le résultat de `/oauth2/authorize`. */
function redirectUrlOf(returned: unknown): string | null {
  if (returned instanceof Response) return returned.headers.get("location")
  if (isAPIError(returned)) {
    const headers = (returned as { headers?: Headers }).headers
    return headers?.get?.("location") ?? null
  }
  if (returned && typeof returned === "object") {
    const url = (returned as { url?: unknown }).url
    return typeof url === "string" ? url : null
  }
  return null
}

/**
 * Code d'autorisation créé par `/oauth2/authorize` : `code` vers le client ou
 * la page de connexion, `consent_code` vers l'écran de consentement — les
 * deux désignent la même valeur de vérification, que le consentement conserve.
 */
export function authorizationCodeFrom(returned: unknown): string | null {
  const location = redirectUrlOf(returned)
  if (!location) return null
  try {
    const url = new URL(location, "https://identite.invalid")
    return url.searchParams.get("code") ?? url.searchParams.get("consent_code")
  } catch {
    return null
  }
}

type VerificationRow = { value: string }

/** Sous-ensemble de `ctx.context.internalAdapter` de Better Auth. */
export type VerificationStore = {
  findVerificationValue: (identifier: string) => Promise<VerificationRow | null | undefined>
  updateVerificationByIdentifier: (identifier: string, data: { value: string }) => Promise<unknown>
}

/** Attache au code le niveau exigé par `acr_values` (aucun effet sinon). */
export async function attachRequestedLevel(
  store: VerificationStore,
  code: string,
  acrValues: unknown,
): Promise<void> {
  const level = levelRequestedByAcrValues(acrValues)
  if (level === 0) return
  const row = await store.findVerificationValue(code)
  if (!row) return
  let value: Record<string, unknown>
  try {
    value = JSON.parse(row.value) as Record<string, unknown>
  } catch {
    return
  }
  await store.updateVerificationByIdentifier(code, {
    value: JSON.stringify({ ...value, [REQUIRED_LEVEL_FIELD]: level }),
  })
}

/** Niveau attaché au code, 0 si aucun (lecture sans consommer le code). */
export async function requestedLevelOfCode(
  store: Pick<VerificationStore, "findVerificationValue">,
  code: unknown,
): Promise<0 | AssuranceLevel> {
  if (typeof code !== "string" || code.length === 0) return 0
  const row = await store.findVerificationValue(code)
  if (!row) return 0
  try {
    const level = (JSON.parse(row.value) as Record<string, unknown>)[REQUIRED_LEVEL_FIELD]
    return level === 1 || level === 2 || level === 3 ? level : 0
  } catch {
    return 0
  }
}
