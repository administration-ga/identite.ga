import { APIError } from "better-auth/api"

/**
 * `/oauth2/register` fermé à tous (CH-820, ADR 0002).
 *
 * La route de Better Auth acceptait toute session, citoyen ordinaire compris,
 * et laissait le demandeur écrire `metadata` — donc `env: "production"`, qui
 * contournait le bac à sable et l'approbation d'un administrateur. Les
 * clients naissent au portail développeur (bac à sable), passent en
 * production par l'approbation d'un administrateur, ou, pour les
 * applications de l'État, par `developer/apps:bootstrapTrustedClient`.
 */

export const DYNAMIC_REGISTRATION_PATH = "/oauth2/register"

export function refuseDynamicRegistration(): never {
  throw new APIError("FORBIDDEN", {
    error: "access_denied",
    error_description:
      "client_registration_closed: les clients se créent au portail développeur d'identite.ga",
  })
}
