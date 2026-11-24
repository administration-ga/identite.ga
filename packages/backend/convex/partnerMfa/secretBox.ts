/**
 * Chiffrement au repos des secrets TOTP des appareils (AES-GCM).
 *
 * Clé : `IDN_AUTHENTICATOR_KEY` (32 octets, hex ou base64url). Si elle n'est pas
 * définie, on retombe sur `WEBHOOK_SECRETS_KEY` (même format). Repli documenté
 * dans docs/partner-mfa.md : il permet de ne pas bloquer le déploiement, mais
 * une clé dédiée est préférable pour séparer les usages. Le vecteur d'AAD
 * (`idn:device-totp:v1`) est distinct de celui des secrets de webhooks : un
 * chiffré ne se déchiffre pas dans l'autre contexte, même avec la même clé.
 */

const encoder = new TextEncoder()
const DEVICE_SECRET_AAD = encoder.encode("idn:device-totp:v1")

function toBase64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/")
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")
  const binary = atob(padded)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

function fromHex(value: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(value)) return null
  return Uint8Array.from(
    value.match(/.{2}/g)!.map((pair) => Number.parseInt(pair, 16)),
  )
}

function masterKeyBytes(): Uint8Array {
  const raw =
    process.env.IDN_AUTHENTICATOR_KEY?.trim() ||
    process.env.WEBHOOK_SECRETS_KEY?.trim()
  if (!raw) throw new Error("IDN_AUTHENTICATOR_KEY_MISSING")
  const decoded = fromHex(raw) ?? fromBase64Url(raw)
  if (decoded.byteLength !== 32) throw new Error("IDN_AUTHENTICATOR_KEY_INVALID")
  return decoded
}

async function importKey(): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    masterKeyBytes() as BufferSource,
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  )
}

export async function sealDeviceSecret(plain: string): Promise<{
  ciphertext: string
  iv: string
}> {
  const iv = new Uint8Array(12)
  crypto.getRandomValues(iv)
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: DEVICE_SECRET_AAD },
    await importKey(),
    encoder.encode(plain),
  )
  return {
    ciphertext: toBase64Url(new Uint8Array(ciphertext)),
    iv: toBase64Url(iv),
  }
}

export async function openDeviceSecret(sealed: {
  ciphertext: string
  iv: string
}): Promise<string> {
  const clear = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: fromBase64Url(sealed.iv) as BufferSource,
      additionalData: DEVICE_SECRET_AAD,
    },
    await importKey(),
    fromBase64Url(sealed.ciphertext) as BufferSource,
  )
  return new TextDecoder().decode(clear)
}
