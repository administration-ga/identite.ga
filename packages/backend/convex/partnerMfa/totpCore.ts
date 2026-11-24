/**
 * TOTP de référence (RFC 4226 / RFC 6238) côté serveur : SHA-1, 6 chiffres,
 * pas de 30 s. Le secret est transporté en base32 (RFC 4648, sans padding),
 * le format que l'app identite.ga affiche et stocke dans son SecureStore.
 *
 * Côté app (apps/mobile/src/lib/authenticator/totp.ts) : même algorithme, en JS
 * pur, car crypto.subtle n'est pas fiable sur tous les moteurs React Native.
 * Les deux implémentations sont testées avec les mêmes vecteurs RFC 6238.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

export const TOTP_STEP_SECONDS = 30
export const TOTP_DIGITS = 6
/** Nombre de pas acceptés de part et d'autre de l'instant courant. */
export const TOTP_WINDOW = 1

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let output = ""
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return output
}

export function base32Decode(input: string): Uint8Array {
  const clean = input.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase()
  const bytes: number[] = []
  let bits = 0
  let value = 0
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char)
    if (index < 0) throw new Error("BASE32_INVALID")
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Uint8Array.from(bytes)
}

/** Secret aléatoire de 160 bits (20 octets), en base32. */
export function generateTotpSecret(): string {
  const bytes = new Uint8Array(20)
  crypto.getRandomValues(bytes)
  return base32Encode(bytes)
}

export async function hotp(
  secretBase32: string,
  counter: number,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    base32Decode(secretBase32) as BufferSource,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  )
  const message = new Uint8Array(8)
  // Compteur sur 64 bits, big-endian. Les pas restent < 2^32 : les deux mots
  // hauts sont donc zéro.
  new DataView(message.buffer).setUint32(4, counter >>> 0)
  new DataView(message.buffer).setUint32(0, Math.floor(counter / 0x1_0000_0000))
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message))
  const offset = mac[mac.length - 1]! & 0x0f
  const binary =
    ((mac[offset]! & 0x7f) << 24) |
    ((mac[offset + 1]! & 0xff) << 16) |
    ((mac[offset + 2]! & 0xff) << 8) |
    (mac[offset + 3]! & 0xff)
  const otp = binary % 10 ** TOTP_DIGITS
  return String(otp).padStart(TOTP_DIGITS, "0")
}

export function timeCounter(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS)
}

/**
 * Pas TOTP correspondant au code, dans la fenêtre ±TOTP_WINDOW autour de
 * l'instant courant. Renvoie null si aucun pas ne correspond.
 */
export async function matchingCounter(
  secretBase32: string,
  code: string,
  nowMs: number,
): Promise<number | null> {
  const current = timeCounter(nowMs)
  for (let delta = -TOTP_WINDOW; delta <= TOTP_WINDOW; delta++) {
    const counter = current + delta
    if (counter < 0) continue
    if ((await hotp(secretBase32, counter)) === code) return counter
  }
  return null
}
