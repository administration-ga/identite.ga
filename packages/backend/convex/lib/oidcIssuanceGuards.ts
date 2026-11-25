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

/**
 * `/oauth2/authorize` : client et adresse de retour contrôlés AVANT la
 * connexion (25/11/2026).
 *
 * Sans session, Better Auth renvoie vers la page de connexion sans rien
 * vérifier (`oidc-provider/authorize.mjs`) et ne contrôle client et adresse
 * qu'une fois l'usager connecté. Un lien forgé faisait saisir identifiant et
 * PIN pour aboutir à une erreur : aucun code ne partait, mais l'usager avait
 * été mis en confiance. On refuse donc d'emblée, sans jamais rediriger vers
 * l'adresse fournie (RFC 6749 §4.1.2.1 : une adresse invalide ne reçoit rien).
 */
export const AUTHORIZE_PATH = "/oauth2/authorize"

/** Ce qu'il faut d'un client enregistré pour juger la demande. */
export type AuthorizeClientView = {
  /** CSV, comme le stocke le portail et comme le lit `getClient` de Better Auth. */
  redirectUrls?: string | null
  disabled?: boolean | null
}

export type AuthorizeRefusal = {
  error: "invalid_client" | "invalid_request"
  error_description: string
}

/**
 * Règle pure. La comparaison reste EXACTE, sans normalisation, comme celle de
 * Better Auth à l'émission du code : le contrôle avancé ne doit jamais être
 * plus permissif que le contrôle final.
 */
export function authorizeRequestRefusal(
  request: { clientId: string; redirectUri: string },
  client: AuthorizeClientView | null,
): AuthorizeRefusal | null {
  if (!request.clientId || !client) {
    return { error: "invalid_client", error_description: "client_id inconnu d'identite.ga" }
  }
  if (client.disabled === true) {
    return { error: "invalid_client", error_description: "ce client est désactivé" }
  }
  const registered = (client.redirectUrls ?? "").split(",")
  if (!request.redirectUri || !registered.includes(request.redirectUri)) {
    return {
      error: "invalid_request",
      error_description: "redirect_uri absente ou non inscrite pour ce client",
    }
  }
  return null
}

export function refuseAuthorizeRequest(refusal: AuthorizeRefusal): never {
  throw new APIError("BAD_REQUEST", refusal)
}

export function refuseDynamicRegistration(): never {
  throw new APIError("FORBIDDEN", {
    error: "access_denied",
    error_description:
      "client_registration_closed: les clients se créent au portail développeur d'identite.ga",
  })
}
