/**
 * Vérification d'ID token OIDC — signature RS256/ES256 via JWKS, claims standards.
 *
 * Implémentation WebCrypto pure, zéro dépendance.
 */

interface JwkKey {
  kty: string
  kid?: string
  alg?: string
  use?: string
  n?: string
  e?: string
  crv?: string
  x?: string
  y?: string
}

interface JwksDocument {
  keys: JwkKey[]
}

const base64UrlDecode = (input: string): Uint8Array => {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4))
  const base64 = (input + pad).replace(/-/g, "+").replace(/_/g, "/")
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

const decodeJwtPart = <T>(part: string): T => {
  const decoder = new TextDecoder()
  return JSON.parse(decoder.decode(base64UrlDecode(part))) as T
}

const ALLOWED_ALGS = new Set(["RS256", "ES256"])

// Famille de clé attendue pour chaque algorithme : une clé publiée pour un
// autre usage n'est jamais essayée (pas de confusion d'algorithme).
const KEY_TYPE_FOR_ALG: Record<string, { kty: string; crv?: string }> = {
  RS256: { kty: "RSA" },
  ES256: { kty: "EC", crv: "P-256" },
}

const jwksCache = new Map<string, { doc: JwksDocument; fetchedAt: number }>()
const JWKS_TTL_MS = 60 * 60 * 1000

/**
 * Intervalle minimal entre deux relectures du JWKS provoquées par un `kid`
 * inconnu. Après une rotation chez IDN, la nouvelle clé est trouvée dès le
 * premier jeton qu'elle signe ; un flot de `kid` inventés ne déclenche, lui,
 * qu'une lecture par fenêtre (même règle que la gateway de la plateforme).
 */
const UNKNOWN_KID_REFRESH_INTERVAL_MS = 30 * 1000
const lastForcedRefreshAt = new Map<string, number>()
const inflight = new Map<string, Promise<JwksDocument>>()

const downloadJwks = async (jwksUri: string): Promise<JwksDocument> => {
  const pending = inflight.get(jwksUri)
  if (pending) return pending
  const request = (async () => {
    const res = await fetch(jwksUri, { headers: { Accept: "application/json" } })
    if (!res.ok) {
      throw new Error(`[@idn-ga/core] JWKS fetch failed (${res.status}) ${jwksUri}`)
    }
    const doc = (await res.json()) as JwksDocument
    if (!doc || !Array.isArray(doc.keys)) {
      throw new Error(`[@idn-ga/core] JWKS mal formé ${jwksUri}`)
    }
    jwksCache.set(jwksUri, { doc, fetchedAt: Date.now() })
    return doc
  })()
  inflight.set(jwksUri, request)
  try {
    return await request
  } finally {
    inflight.delete(jwksUri)
  }
}

const fetchJwks = async (jwksUri: string): Promise<JwksDocument> => {
  const cached = jwksCache.get(jwksUri)
  if (cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) return cached.doc
  return downloadJwks(jwksUri)
}

/**
 * Clé du `kid` demandé ; relit le JWKS une fois (bornée) si le `kid` est
 * inconnu du cache. Ne retombe JAMAIS sur une autre clé : un `kid` inconnu
 * après relecture est un refus.
 */
const findKey = async (jwksUri: string, kid: string): Promise<JwkKey | undefined> => {
  const cached = await fetchJwks(jwksUri)
  const known = cached.keys.find((k) => k.kid === kid)
  if (known) return known
  const last = lastForcedRefreshAt.get(jwksUri) ?? 0
  if (Date.now() - last < UNKNOWN_KID_REFRESH_INTERVAL_MS) return undefined
  lastForcedRefreshAt.set(jwksUri, Date.now())
  const fresh = await downloadJwks(jwksUri)
  return fresh.keys.find((k) => k.kid === kid)
}

/** Module RSA minimal admis (NIST SP 800-57 : 112 bits de sécurité). */
const MIN_RSA_MODULUS_BITS = 2048

const rsaModulusBits = (n: string | undefined): number => {
  if (!n) return 0
  const bytes = base64UrlDecode(n)
  let leading = 0
  while (leading < bytes.length && bytes[leading] === 0) leading++
  const first = bytes[leading] ?? 0
  return (bytes.length - leading - 1) * 8 + (first ? Math.floor(Math.log2(first)) + 1 : 0)
}

const assertKeyMatchesAlg = (jwk: JwkKey, alg: string): void => {
  const expected = KEY_TYPE_FOR_ALG[alg]
  if (!expected || jwk.kty !== expected.kty || (expected.crv && jwk.crv !== expected.crv)) {
    throw new Error(`[@idn-ga/core] Clé JWKS incompatible avec l'alg ${alg}`)
  }
  // RS256 : la clé doit annoncer son alg (IDN le publie sur chaque clé) et
  // un module d'au moins 2048 bits.
  if (alg === "RS256") {
    if (jwk.alg === undefined) {
      throw new Error("[@idn-ga/core] Clé JWKS RS256 publiée sans alg")
    }
    if (rsaModulusBits(jwk.n) < MIN_RSA_MODULUS_BITS) {
      throw new Error(`[@idn-ga/core] Module RSA inférieur à ${MIN_RSA_MODULUS_BITS} bits`)
    }
  }
  if (jwk.alg !== undefined && jwk.alg !== alg) {
    throw new Error(`[@idn-ga/core] Clé JWKS publiée pour l'alg ${jwk.alg}, jeton en ${alg}`)
  }
  if (jwk.use !== undefined && jwk.use !== "sig") {
    throw new Error("[@idn-ga/core] Clé JWKS non destinée à la signature")
  }
}

/** Niveau eIDAS porté par la revendication `acr` (0 si absente ou inconnue). */
const LEVEL_FOR_ACR: Record<string, 1 | 2 | 3> = { eidas1: 1, eidas2: 2, eidas3: 3 }

export const levelOfAcr = (acr: unknown): 0 | 1 | 2 | 3 =>
  typeof acr === "string" ? (LEVEL_FOR_ACR[acr] ?? 0) : 0

const importKey = async (jwk: JwkKey, alg: string): Promise<CryptoKey> => {
  if (alg === "RS256") {
    return crypto.subtle.importKey(
      "jwk",
      jwk as JsonWebKey,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    )
  }
  if (alg === "ES256") {
    return crypto.subtle.importKey(
      "jwk",
      jwk as JsonWebKey,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    )
  }
  throw new Error(`[@idn-ga/core] Algorithme non supporté : ${alg}`)
}

const verifySignature = async (
  key: CryptoKey,
  alg: string,
  signedInput: string,
  signature: Uint8Array,
): Promise<boolean> => {
  const data = new TextEncoder().encode(signedInput) as BufferSource
  const sig = signature as BufferSource
  if (alg === "RS256") {
    return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, data)
  }
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, data)
}

export interface VerifyOptions {
  issuer: string
  audience: string
  jwksUri: string
  /** Nonce attendu (vérifié si fourni) */
  nonce?: string
  /** Tolérance d'horloge en secondes (défaut : 60) */
  clockSkew?: number
  /**
   * Niveau de garantie minimal exigé (1, 2 ou 3), lu dans la revendication
   * `acr` (`eidas1`…`eidas3`). Un jeton sans `acr` reconnu est refusé.
   */
  minLevel?: 1 | 2 | 3
}

export interface DecodedIdToken {
  header: { alg: string; kid?: string; typ?: string }
  payload: {
    iss: string
    aud: string | string[]
    sub: string
    exp: number
    iat: number
    nbf?: number
    nonce?: string
    [claim: string]: unknown
  }
}

export const verifyIdToken = async (
  token: string,
  opts: VerifyOptions,
): Promise<DecodedIdToken> => {
  const parts = token.split(".")
  if (parts.length !== 3) {
    throw new Error("[@idn-ga/core] ID token mal formé (≠ 3 segments)")
  }
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string]
  const header = decodeJwtPart<DecodedIdToken["header"]>(headerB64)
  const payload = decodeJwtPart<DecodedIdToken["payload"]>(payloadB64)

  if (!ALLOWED_ALGS.has(header.alg)) {
    throw new Error(
      `[@idn-ga/core] Algo ID token refusé : ${header.alg} (autorisés : RS256, ES256)`,
    )
  }

  if (typeof header.kid !== "string" || header.kid.length === 0) {
    throw new Error("[@idn-ga/core] ID token sans kid")
  }
  const jwk = await findKey(opts.jwksUri, header.kid)
  if (!jwk) {
    throw new Error(`[@idn-ga/core] kid inconnu du JWKS : ${header.kid}`)
  }
  assertKeyMatchesAlg(jwk, header.alg)

  const cryptoKey = await importKey(jwk, header.alg)
  const signature = base64UrlDecode(signatureB64)
  const valid = await verifySignature(
    cryptoKey,
    header.alg,
    `${headerB64}.${payloadB64}`,
    signature,
  )
  if (!valid) throw new Error("[@idn-ga/core] Signature ID token invalide")

  if (payload.iss !== opts.issuer) {
    throw new Error(
      `[@idn-ga/core] Issuer mismatch : attendu ${opts.issuer}, reçu ${payload.iss}`,
    )
  }
  const audOk = Array.isArray(payload.aud)
    ? payload.aud.includes(opts.audience)
    : payload.aud === opts.audience
  if (!audOk) {
    throw new Error("[@idn-ga/core] Audience mismatch")
  }
  const now = Math.floor(Date.now() / 1000)
  const skew = opts.clockSkew ?? 60
  if (payload.exp + skew < now) throw new Error("[@idn-ga/core] ID token expiré")
  if (payload.iat - skew > now) throw new Error("[@idn-ga/core] ID token iat dans le futur")
  if (payload.nbf !== undefined && payload.nbf - skew > now) {
    throw new Error("[@idn-ga/core] ID token nbf dans le futur")
  }
  if (opts.nonce !== undefined && payload.nonce !== opts.nonce) {
    throw new Error("[@idn-ga/core] Nonce mismatch")
  }
  if (opts.minLevel !== undefined) {
    const level = levelOfAcr(payload.acr)
    if (level < opts.minLevel) {
      throw new Error(
        `[@idn-ga/core] Niveau de garantie insuffisant : eidas${opts.minLevel} exigé, reçu ${String(payload.acr ?? "aucun")}`,
      )
    }
  }

  return { header, payload }
}

export const clearJwksCache = (jwksUri?: string): void => {
  if (jwksUri) {
    jwksCache.delete(jwksUri)
    lastForcedRefreshAt.delete(jwksUri)
  } else {
    jwksCache.clear()
    lastForcedRefreshAt.clear()
  }
}
