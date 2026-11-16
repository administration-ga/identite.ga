/**
 * TOTP (RFC 6238) en JavaScript pur : SHA-1, HMAC-SHA1, base32, 6 chiffres,
 * pas de 30 s. Même algorithme que le serveur (convex/partnerMfa/totpCore.ts).
 *
 * Pourquoi pas `crypto.subtle` : il n'est pas fiable sur tous les moteurs
 * React Native (Hermes). Le calcul est synchrone, il tourne à chaque seconde
 * sur l'écran des codes sans rien envoyer au réseau.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;

function rotl(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

/** SHA-1 (FIPS 180-4) sur un tableau d'octets. */
export function sha1(message: Uint8Array): Uint8Array {
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const bitLength = message.length * 8;
  // Message + bit « 1 » + zéros + longueur sur 64 bits, multiple de 64 octets.
  const paddedLength = Math.ceil((message.length + 9) / 64) * 64;
  const data = new Uint8Array(paddedLength);
  data.set(message);
  data[message.length] = 0x80;
  const view = new DataView(data.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const w = new Uint32Array(80);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 80; i++) {
      w[i] = rotl(w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!, 1);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (rotl(a, 5) + (f >>> 0) + e + k + w[i]!) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  [h0, h1, h2, h3, h4].forEach((word, index) => outView.setUint32(index * 4, word));
  return out;
}

/** HMAC-SHA1 (RFC 2104), bloc de 64 octets. */
export function hmacSha1(key: Uint8Array, message: Uint8Array): Uint8Array {
  const block = 64;
  const normalizedKey = key.length > block ? sha1(key) : key;
  const padded = new Uint8Array(block);
  padded.set(normalizedKey);

  const inner = new Uint8Array(block + message.length);
  const outer = new Uint8Array(block + 20);
  for (let i = 0; i < block; i++) {
    inner[i] = padded[i]! ^ 0x36;
    outer[i] = padded[i]! ^ 0x5c;
  }
  inner.set(message, block);
  outer.set(sha1(inner), block);
  return sha1(outer);
}

export function base32Decode(input: string): Uint8Array {
  const clean = input.replace(/[\s=]+/g, '').toUpperCase();
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error('BASE32_INVALID');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(bytes);
}

/** HOTP (RFC 4226) : code à `digits` chiffres pour un compteur donné. */
export function hotp(secretBase32: string, counter: number, digits = TOTP_DIGITS): string {
  const message = new Uint8Array(8);
  const view = new DataView(message.buffer);
  view.setUint32(0, Math.floor(counter / 0x1_0000_0000));
  view.setUint32(4, counter >>> 0);
  const mac = hmacSha1(base32Decode(secretBase32), message);
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) |
    ((mac[offset + 1]! & 0xff) << 16) |
    ((mac[offset + 2]! & 0xff) << 8) |
    (mac[offset + 3]! & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** Code TOTP à l'instant `timeMs` (millisecondes depuis l'époque). */
export function totpAt(secretBase32: string, timeMs: number): string {
  const counter = Math.floor(timeMs / 1000 / TOTP_PERIOD_SECONDS);
  return hotp(secretBase32, counter);
}

/** Secondes restantes avant le prochain code, de 30 à 1. */
export function secondsUntilNextCode(timeMs: number): number {
  return TOTP_PERIOD_SECONDS - (Math.floor(timeMs / 1000) % TOTP_PERIOD_SECONDS);
}

/** Affichage « 123 456 » : deux groupes de trois. */
export function formatTotpCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}
