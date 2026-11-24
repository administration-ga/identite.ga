import { describe, expect, it } from "vitest"

import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  matchingCounter,
  timeCounter,
} from "./totpCore"

/** Secret de test de la RFC 6238 (ASCII « 12345678901234567890 »), en base32. */
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"

/**
 * Vecteurs RFC 6238 Annexe B, SHA-1, 6 derniers chiffres. Recalculés aussi
 * indépendamment avec Python (hmac/hashlib) avant d'être fixés ici.
 */
const RFC_VECTORS: Array<[number, string]> = [
  [59, "287082"],
  [1111111109, "081804"],
  [1111111111, "050471"],
  [1234567890, "005924"],
  [2000000000, "279037"],
  [20000000000, "353130"],
]

describe("base32", () => {
  it("encode et décode à l'identique", () => {
    const bytes = Uint8Array.from([0, 1, 2, 127, 128, 254, 255, 42])
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes)
  })

  it("respecte le vecteur RFC 4648 pour « foobar »", () => {
    expect(base32Encode(new TextEncoder().encode("foobar"))).toBe("MZXW6YTBOI")
    expect(
      new TextDecoder().decode(base32Decode("MZXW6YTBOI")),
    ).toBe("foobar")
  })

  it("ignore la casse, les espaces et le padding, et rejette les caractères hors alphabet", () => {
    expect(
      new TextDecoder().decode(base32Decode("mzxw 6ytb oi==")),
    ).toBe("foobar")
    expect(() => base32Decode("MZ1W")).toThrow("BASE32_INVALID")
  })
})

describe("HOTP / TOTP (RFC 6238, SHA-1)", () => {
  it.each(RFC_VECTORS)("produit le code attendu à t=%i", async (time, code) => {
    expect(await hotp(RFC_SECRET, timeCounter(time * 1000))).toBe(code)
  })

  it("génère des secrets de 160 bits, distincts à chaque appel", () => {
    const first = generateTotpSecret()
    const second = generateTotpSecret()
    expect(first).toMatch(/^[A-Z2-7]{32}$/)
    expect(first).not.toBe(second)
    expect(base32Decode(first)).toHaveLength(20)
  })
})

describe("matchingCounter", () => {
  const now = 1111111111 * 1000 // pas 37037037, code 050471

  it("accepte le code du pas courant", async () => {
    expect(await matchingCounter(RFC_SECRET, "050471", now)).toBe(
      timeCounter(now),
    )
  })

  it("accepte le pas précédent et le suivant (fenêtre ±1)", async () => {
    const previousStepCode = await hotp(RFC_SECRET, timeCounter(now) - 1)
    const nextStepCode = await hotp(RFC_SECRET, timeCounter(now) + 1)
    expect(await matchingCounter(RFC_SECRET, previousStepCode, now)).toBe(
      timeCounter(now) - 1,
    )
    expect(await matchingCounter(RFC_SECRET, nextStepCode, now)).toBe(
      timeCounter(now) + 1,
    )
  })

  it("refuse un code hors fenêtre (deux pas)", async () => {
    const farCode = await hotp(RFC_SECRET, timeCounter(now) + 2)
    // Le code à +2 pas ne doit pas correspondre à la fenêtre ±1 — sauf
    // collision improbable sur 10^6 valeurs, ce que le jeu de test exclut.
    const window = [-1, 0, 1].map((d) => timeCounter(now) + d)
    const codes = await Promise.all(window.map((c) => hotp(RFC_SECRET, c)))
    expect(codes).not.toContain(farCode)
    expect(await matchingCounter(RFC_SECRET, farCode, now)).toBeNull()
  })

  it("refuse un code faux", async () => {
    expect(await matchingCounter(RFC_SECRET, "000000", now)).toBeNull()
  })
})
