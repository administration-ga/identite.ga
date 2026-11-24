import { describe, expect, it } from "vitest"

import {
  LIMITS,
  REQUEST_TTL_MS,
  drawChallenge,
  effectiveStatus,
  parseCreateRequestBody,
  parseIdBody,
  parseIdQuery,
  parseSubBody,
  parseSubQuery,
  parseTotpBody,
  randomIntInclusive,
} from "./rules"

/** Source déterministe : une suite de valeurs données, recyclée. */
function sequence(values: number[]) {
  let index = 0
  return (buffer: Uint32Array) => {
    buffer[0] = values[index % values.length]!
    index++
    return buffer
  }
}

describe("drawChallenge", () => {
  it("tire un nombre à 2 chiffres et trois choix distincts, dont le bon", () => {
    for (let run = 0; run < 200; run++) {
      const challenge = drawChallenge()
      expect(challenge.number).toMatch(/^[1-9][0-9]$/)
      expect(challenge.choices).toHaveLength(3)
      expect(new Set(challenge.choices).size).toBe(3)
      expect(challenge.choices).toContain(challenge.number)
      for (const choice of challenge.choices) {
        expect(Number(choice)).toBeGreaterThanOrEqual(10)
        expect(Number(choice)).toBeLessThanOrEqual(99)
      }
    }
  })

  it("n'est pas figé : le nombre varie d'un tirage à l'autre", () => {
    const numbers = new Set(Array.from({ length: 50 }, () => drawChallenge().number))
    expect(numbers.size).toBeGreaterThan(5)
  })

  it("reste correct avec une source contrôlée (le bon nombre est toujours parmi les choix)", () => {
    // Valeurs qui forcent des collisions : le tirage doit les rejeter.
    const random = sequence([0, 0, 0, 1, 1, 2, 3, 5, 8, 13, 21, 34])
    const challenge = drawChallenge(random)
    expect(new Set(challenge.choices).size).toBe(3)
    expect(challenge.choices).toContain(challenge.number)
  })
})

describe("randomIntInclusive", () => {
  it("reste dans les bornes, bornes incluses", () => {
    expect(randomIntInclusive(5, 5)).toBe(5)
    for (let i = 0; i < 100; i++) {
      const value = randomIntInclusive(10, 99)
      expect(value).toBeGreaterThanOrEqual(10)
      expect(value).toBeLessThanOrEqual(99)
    }
  })

  it("rejette les valeurs au-delà de la plus grande multiple de l'intervalle (pas de biais)", () => {
    const span = 90
    const limit = Math.floor(0x1_0000_0000 / span) * span
    // Première valeur hors limite (rejetée), puis une valeur acceptable.
    const random = sequence([limit, 0])
    expect(randomIntInclusive(10, 99, random)).toBe(10)
  })
})

describe("effectiveStatus", () => {
  it("présente une demande pending échue comme expired", () => {
    expect(effectiveStatus({ status: "pending", expiresAt: 1000 }, 1000)).toBe("expired")
    expect(effectiveStatus({ status: "pending", expiresAt: 1000 }, 1500)).toBe("expired")
  })

  it("garde le statut tant que l'échéance n'est pas passée", () => {
    expect(effectiveStatus({ status: "pending", expiresAt: 1000 }, 999)).toBe("pending")
  })

  it("ne change jamais une décision déjà prise", () => {
    expect(effectiveStatus({ status: "approved", expiresAt: 1000 }, 5000)).toBe("approved")
    expect(effectiveStatus({ status: "denied", expiresAt: 1000 }, 5000)).toBe("denied")
  })

  it("donne à une demande une durée de vie de 2 minutes", () => {
    expect(REQUEST_TTL_MS).toBe(120_000)
  })
})

describe("parseCreateRequestBody", () => {
  const valid = { sub: "user_1", kind: "login" }

  it("accepte le minimum requis", () => {
    expect(parseCreateRequestBody(valid)).toEqual({
      ok: true,
      value: {
        sub: "user_1",
        kind: "login",
        actionLabel: undefined,
        context: {},
      },
    })
  })

  it("accepte les trois types de demande", () => {
    for (const kind of ["enroll", "login", "sensitive"]) {
      expect(parseCreateRequestBody({ sub: "u", kind }).ok).toBe(true)
    }
  })

  it("refuse un corps qui n'est pas un objet", () => {
    expect(parseCreateRequestBody(null).ok).toBe(false)
    expect(parseCreateRequestBody([valid]).ok).toBe(false)
    expect(parseCreateRequestBody("login").ok).toBe(false)
  })

  it("refuse un champ inconnu (faute de frappe)", () => {
    const result = parseCreateRequestBody({ ...valid, kidn: "login" })
    expect(result).toMatchObject({ ok: false })
  })

  it("refuse un sub vide ou absent", () => {
    expect(parseCreateRequestBody({ kind: "login" }).ok).toBe(false)
    expect(parseCreateRequestBody({ sub: "   ", kind: "login" }).ok).toBe(false)
    expect(parseCreateRequestBody({ sub: 42, kind: "login" }).ok).toBe(false)
    expect(
      parseCreateRequestBody({ sub: "x".repeat(LIMITS.sub + 1), kind: "login" }).ok,
    ).toBe(false)
  })

  it("refuse un kind hors liste", () => {
    expect(parseCreateRequestBody({ sub: "u", kind: "admin" }).ok).toBe(false)
  })

  it("borne actionLabel à 100 caractères", () => {
    expect(
      parseCreateRequestBody({ ...valid, kind: "sensitive", actionLabel: "a".repeat(100) }).ok,
    ).toBe(true)
    expect(
      parseCreateRequestBody({ ...valid, kind: "sensitive", actionLabel: "a".repeat(101) }).ok,
    ).toBe(false)
  })

  it("borne device et location à 80, ip à 45, et refuse les champs de contexte inconnus", () => {
    expect(
      parseCreateRequestBody({ ...valid, context: { device: "d".repeat(80) } }).ok,
    ).toBe(true)
    expect(
      parseCreateRequestBody({ ...valid, context: { device: "d".repeat(81) } }).ok,
    ).toBe(false)
    expect(
      parseCreateRequestBody({ ...valid, context: { location: "l".repeat(81) } }).ok,
    ).toBe(false)
    expect(
      parseCreateRequestBody({ ...valid, context: { ip: "1".repeat(46) } }).ok,
    ).toBe(false)
    expect(
      parseCreateRequestBody({ ...valid, context: { userAgent: "x" } }).ok,
    ).toBe(false)
  })

  it("traite un libellé ou un contexte vide comme absent", () => {
    const result = parseCreateRequestBody({
      ...valid,
      actionLabel: "   ",
      context: { device: "  " },
    })
    expect(result).toMatchObject({
      ok: true,
      value: { actionLabel: undefined, context: { device: undefined } },
    })
  })
})

describe("parseIdQuery / parseIdBody / parseSubQuery / parseSubBody", () => {
  it("exige un identifiant et un sujet non vides", () => {
    expect(parseIdQuery(null).ok).toBe(false)
    expect(parseIdQuery("  ").ok).toBe(false)
    expect(parseIdQuery("abc")).toEqual({ ok: true, value: "abc" })
    expect(parseIdBody({ id: "abc" })).toEqual({ ok: true, value: "abc" })
    expect(parseIdBody({ id: "abc", extra: 1 }).ok).toBe(false)
    expect(parseSubQuery(null).ok).toBe(false)
    expect(parseSubQuery("user_1")).toEqual({ ok: true, value: "user_1" })
    expect(parseSubBody({ sub: "user_1" })).toEqual({ ok: true, value: "user_1" })
    expect(parseSubBody({ sub: "user_1", clientId: "x" }).ok).toBe(false)
  })
})

describe("parseTotpBody", () => {
  it("accepte exactement six chiffres", () => {
    expect(parseTotpBody({ sub: "u", code: "012345" })).toEqual({
      ok: true,
      value: { sub: "u", code: "012345" },
    })
  })

  it("refuse les codes de mauvaise forme", () => {
    for (const code of ["12345", "1234567", "12a456", "123 456", 123456, undefined]) {
      expect(parseTotpBody({ sub: "u", code }).ok).toBe(false)
    }
  })

  it("exige un sub et refuse les champs inconnus", () => {
    expect(parseTotpBody({ code: "123456" }).ok).toBe(false)
    expect(parseTotpBody({ sub: "u", code: "123456", extra: true }).ok).toBe(false)
  })
})
