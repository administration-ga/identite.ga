/**
 * Authentification des clients partenaires (serveur à serveur).
 *
 * Partagé entre l'échange de session (`partnerTokenExchange.ts`, secret dans le
 * corps JSON) et l'API « confirmation de connexion » (`partnerMfa/`, secret dans
 * `Authorization: Basic`). La règle de vérification est la même dans les deux :
 * client existant, actif, confidentiel, et secret comparé à son empreinte.
 *
 * Le secret n'est jamais stocké en clair : `oauthApplication.clientSecret`
 * contient base64url(SHA-256(secret)) sans padding, le format du portail
 * développeur (`developer/apps.ts`) et de `storeClientSecret: "hashed"`.
 */

/** Même format que `defaultClientSecretHasher` de Better Auth. */
export async function hashClientSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret) as BufferSource,
  )
  let binary = ""
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** Comparaison à temps constant de deux chaînes de même nature. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Liste d'identifiants séparés par des virgules (variable d'environnement). */
export function parseClientIdList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
}

/** Ligne `oauthApplication` telle que lue via le composant Better Auth. */
export type PartnerClientRow = {
  clientId: string
  clientSecret?: string | null
  type?: string | null
  disabled?: boolean | null
  name?: string | null
  icon?: string | null
}

export type AuthenticatedPartnerClient = {
  clientId: string
  name: string
  icon: string | null
}

/**
 * Décide si le secret présenté correspond au client. Renvoie null dans tous
 * les cas d'échec, sans dire lequel : l'appelant répond le même `invalid_client`.
 */
export async function authenticatePartnerClient(
  row: PartnerClientRow | null,
  presentedSecret: string,
): Promise<AuthenticatedPartnerClient | null> {
  if (!row || row.disabled || row.type === "public") return null
  if (!row.clientSecret) return null
  const presentedHash = await hashClientSecret(presentedSecret)
  if (!constantTimeEqual(presentedHash, row.clientSecret)) return null
  return {
    clientId: row.clientId,
    name: row.name?.trim() || row.clientId,
    icon: row.icon ?? null,
  }
}

/**
 * Lit `Authorization: Basic base64(client_id:client_secret)`. Le client_id ne
 * contient jamais de `:` : on coupe à la première occurrence, le secret peut
 * en contenir.
 */
export function parseBasicCredentials(
  header: string | null,
): { clientId: string; clientSecret: string } | null {
  const match = /^Basic\s+(\S+)$/i.exec(header?.trim() ?? "")
  if (!match) return null
  let decoded: string
  try {
    const binary = atob(match[1]!)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    decoded = new TextDecoder().decode(bytes)
  } catch {
    return null
  }
  const separator = decoded.indexOf(":")
  if (separator <= 0) return null
  const clientId = decoded.slice(0, separator)
  const clientSecret = decoded.slice(separator + 1)
  if (!clientId || !clientSecret) return null
  return { clientId, clientSecret }
}

export type PartnerAdmission =
  | { ok: true; client: AuthenticatedPartnerClient }
  | {
      ok: false
      status: 401 | 403
      error: "invalid_client" | "client_not_allowed"
    }

/**
 * Admission complète d'un appelant : secret valide, puis présence dans la liste
 * blanche (`IDN_MFA_CLIENT_IDS`). Un secret faux donne toujours 401, même pour
 * un client hors liste : un appelant anonyme ne découvre pas la liste.
 */
export async function admitPartnerClient(
  row: PartnerClientRow | null,
  presentedSecret: string,
  allowlistRaw: string | undefined,
): Promise<PartnerAdmission> {
  const client = await authenticatePartnerClient(row, presentedSecret)
  if (!client) return { ok: false, status: 401, error: "invalid_client" }
  if (!parseClientIdList(allowlistRaw).includes(client.clientId)) {
    return { ok: false, status: 403, error: "client_not_allowed" }
  }
  return { ok: true, client }
}
