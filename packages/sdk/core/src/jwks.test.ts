import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { clearJwksCache, verifyIdToken } from "./jwks.js"

// Tests du vérificateur d'ID token face à une rotation des clés d'IDN.
// Les clés RSA sont générées en WebCrypto, le JWKS est servi par un `fetch`
// simulé dont le contenu change au fil du test : aucune requête réseau.

const ISSUER = "https://site.identite.ga"
const AUDIENCE = "idn_ae_ministere_ga"
const JWKS_URI = `${ISSUER}/api/auth/convex/jwks`

type SigningKey = { kid: string; privateKey: CryptoKey; publicJwk: JsonWebKey }

const encoder = new TextEncoder()

const base64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

const encodePart = (value: unknown): string => base64Url(encoder.encode(JSON.stringify(value)))

async function makeKey(kid: string, modulusLength = 2048): Promise<SigningKey> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey)
  return { kid, privateKey: pair.privateKey, publicJwk }
}

const jwkOf = (key: SigningKey) => ({
  kty: "RSA",
  n: key.publicJwk.n,
  e: key.publicJwk.e,
  alg: "RS256",
  kid: key.kid,
})

async function sign(
  key: SigningKey,
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = { alg: "RS256", kid: key.kid },
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const payload = { iss: ISSUER, aud: AUDIENCE, sub: "sujet-idn", iat: now, exp: now + 3600, ...claims }
  const input = `${encodePart(header)}.${encodePart(payload)}`
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, encoder.encode(input))
  return `${input}.${base64Url(new Uint8Array(signature))}`
}

// JWKS servi par le faux fournisseur ; modifiable pendant le test.
let published: ReturnType<typeof jwkOf>[] = []
const fetchMock = vi.fn(async () =>
  new Response(JSON.stringify({ keys: published }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }),
)

const verify = (token: string, extra: Partial<Parameters<typeof verifyIdToken>[1]> = {}) =>
  verifyIdToken(token, { issuer: ISSUER, audience: AUDIENCE, jwksUri: JWKS_URI, ...extra })

let keyA: SigningKey
let keyB: SigningKey

beforeEach(async () => {
  clearJwksCache()
  fetchMock.mockClear()
  vi.stubGlobal("fetch", fetchMock)
  keyA = await makeKey("cle-a")
  keyB = await makeKey("cle-b")
  published = [jwkOf(keyA)]
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("rotation des clés : relecture du JWKS sur kid inconnu", () => {
  it("accepte le jeton signé par la nouvelle clé publiée après la mise en cache", async () => {
    await verify(await sign(keyA))
    // IDN tourne : la nouvelle clé signe, l'ancienne reste publiée.
    published = [jwkOf(keyB), jwkOf(keyA)]
    const decoded = await verify(await sign(keyB))
    expect(decoded.header.kid).toBe("cle-b")
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("accepte encore un jeton de l'ancienne clé pendant le recouvrement", async () => {
    const ancien = await sign(keyA)
    published = [jwkOf(keyB), jwkOf(keyA)]
    clearJwksCache()
    await expect(verify(ancien)).resolves.toMatchObject({ header: { kid: "cle-a" } })
  })

  it("ne retombe jamais sur une autre clé quand le kid reste inconnu", async () => {
    // Signé par A mais annoncé sous un kid absent : l'ancien code essayait
    // la première clé du JWKS et l'acceptait.
    const token = await sign(keyA, {}, { alg: "RS256", kid: "kid-invente" })
    await expect(verify(token)).rejects.toThrow(/kid/i)
  })

  it("refuse un jeton sans kid", async () => {
    const token = await sign(keyA, {}, { alg: "RS256" })
    await expect(verify(token)).rejects.toThrow(/kid/i)
  })

  it("borne les relectures : un flot de kids inventés ne relit le JWKS qu'une fois par fenêtre", async () => {
    await verify(await sign(keyA))
    for (const kid of ["x1", "x2", "x3"]) {
      const token = await sign(keyA, {}, { alg: "RS256", kid })
      await expect(verify(token)).rejects.toThrow(/kid/i)
    }
    // Lecture initiale + une seule relecture dans la fenêtre de 30 s.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("relit de nouveau une fois la fenêtre écoulée", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    await verify(await sign(keyA))
    await expect(verify(await sign(keyB))).rejects.toThrow(/kid/i)
    vi.setSystemTime(Date.now() + 31_000)
    published = [jwkOf(keyB), jwkOf(keyA)]
    await expect(verify(await sign(keyB))).resolves.toMatchObject({ header: { kid: "cle-b" } })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it("refuse une clé RS256 publiée sans alg", async () => {
    const sansAlg: Partial<ReturnType<typeof jwkOf>> = { ...jwkOf(keyA) }
    delete sansAlg.alg
    published = [sansAlg as ReturnType<typeof jwkOf>]
    await expect(verify(await sign(keyA))).rejects.toThrow(/alg/i)
  })

  it("refuse un module RSA de moins de 2048 bits", async () => {
    const faible = await makeKey("cle-faible", 1024)
    published = [jwkOf(faible)]
    await expect(verify(await sign(faible))).rejects.toThrow(/2048/)
  })

  it("accepte une clé RSA 3072 (clés de rotation d'IDN)", async () => {
    const forte = await makeKey("cle-3072", 3072)
    published = [jwkOf(forte)]
    await expect(verify(await sign(forte))).resolves.toMatchObject({ header: { kid: "cle-3072" } })
  })

  it("refuse une clé publiée pour un autre algorithme que celui du jeton", async () => {
    published = [{ ...jwkOf(keyA), alg: "PS256" }]
    await expect(verify(await sign(keyA))).rejects.toThrow(/alg/i)
  })
})

describe("niveau d'assurance minimal", () => {
  it.each([
    ["eidas2", 2],
    ["eidas3", 2],
    ["eidas3", 3],
  ] as const)("accepte acr %s pour un minimum de %i", async (acr, minLevel) => {
    await expect(verify(await sign(keyA, { acr, loa: Number(acr.slice(-1)) }), { minLevel })).resolves.toBeTruthy()
  })

  it.each([
    [{ acr: "eidas1", loa: 1 }, 2],
    [{ acr: "eidas2", loa: 2 }, 3],
    [{}, 2],
    [{ acr: "urn:mace:incommon:iap:silver" }, 2],
  ] as const)("refuse %j sous le minimum %i", async (claims, minLevel) => {
    await expect(verify(await sign(keyA, claims), { minLevel })).rejects.toThrow(/niveau/i)
  })
})
