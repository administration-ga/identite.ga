/// <reference types="vite/client" />
import { register as registerAggregate } from "@convex-dev/aggregate/test"
import { register as registerBetterAuth } from "@convex-dev/better-auth/test"
import { convexTest } from "convex-test"
import { describe, expect, test, vi } from "vitest"

import { createLocalJWKSet, jwtVerify } from "jose"

import { components, internal } from "./_generated/api"
import { hashClientSecret } from "./lib/partnerClientAuth"
import schema from "./schema"

// Durcissement du fournisseur OIDC (CH-820), joué de bout en bout sur les
// vraies routes Better Auth servies par http.ts : session ordinaire,
// inscription de client, autorisation PKCE, émission des jetons, userinfo.
// Aucune clé de déploiement ni requête réseau.

const modules = import.meta.glob("/convex/**/*.ts")

const REDIRECT_URI = "https://ae.ministere.example/api/auth/oauth2/callback/idn"
const CLIENT_SECRET = "secret-de-test-ch820-ne-sert-qu-ici"

type Level = 1 | 2 | 3

function makeTestClient() {
  const t = convexTest(schema, modules)
  registerAggregate(t, "kycByStatus")
  registerAggregate(t, "usersByLoa")
  registerAggregate(t, "usersByProfile")
  registerBetterAuth(t)
  return t
}

type TestClient = ReturnType<typeof makeTestClient>

/** Un citoyen ordinaire, avec sa session Better Auth et son niveau. */
async function seedCitizen(t: TestClient, loa: Level | null, email = "citoyen.ordinaire@idn.ga") {
  const now = Date.now()
  const token = `jeton-de-session-${loa}-${Math.random().toString(36).slice(2)}`
  return await t.run(async (ctx) => {
    const user = (await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "user",
        data: { email, name: "NDONG Jean", emailVerified: true, createdAt: now, updatedAt: now },
      },
    })) as { _id: string }
    await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "session",
        data: { token, userId: user._id, expiresAt: now + 3_600_000, createdAt: now, updatedAt: now },
      },
    })
    if (loa !== null) await ctx.db.insert("userProfile", {
      userId: user._id,
      profileType: "citizen",
      loa,
      createdAt: now,
      updatedAt: now,
    })
    return { userId: user._id, token }
  })
}

async function setLevel(t: TestClient, userId: string, loa: Level) {
  await t.run(async (ctx) => {
    const profile = await ctx.db
      .query("userProfile")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique()
    if (!profile) throw new Error("profil absent")
    await ctx.db.patch(profile._id, { loa })
  })
}

/** Client confidentiel de production, déjà consenti par le citoyen. */
async function seedClient(
  t: TestClient,
  opts: {
    loa: Level | "illisible"
    strict?: boolean
    env?: "production" | "sandbox"
    testUsers?: string[]
    clientId?: string
    consentFor?: string
    scopes?: string[]
  },
) {
  const now = Date.now()
  const clientId = opts.clientId ?? `idn_test_${opts.loa}_${Math.random().toString(36).slice(2, 8)}`
  const scopes = opts.scopes ?? ["openid", "profile", "email"]
  await t.run(async (ctx) => {
    await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "oauthApplication",
        data: {
          clientId,
          clientSecret: await hashClientSecret(CLIENT_SECRET),
          name: `Client de test ${clientId}`,
          redirectUrls: REDIRECT_URI,
          type: "web",
          disabled: false,
          userId: "",
          metadata: JSON.stringify({
            env: opts.env ?? "production",
            loa: opts.loa,
            ...(opts.strict ? { loaEnforcement: "strict" } : {}),
            description: "",
            scopes,
            createdBy: "",
            services: [],
            testUsers: opts.testUsers ?? [],
            status: "production",
          }),
          createdAt: now,
          updatedAt: now,
        },
      },
    })
    if (opts.consentFor) {
      await ctx.runMutation(components.betterAuth.adapter.create, {
        input: {
          model: "oauthConsent",
          data: {
            clientId,
            userId: opts.consentFor,
            scopes: scopes.join(" "),
            consentGiven: true,
            createdAt: now,
            updatedAt: now,
          },
        },
      })
    }
  })
  return clientId
}

const base64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

async function pkcePair() {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(48)))
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  return { verifier, challenge: base64Url(new Uint8Array(digest)) }
}

/** Autorisation d'un client déjà consenti : le code revient sans écran. */
async function authorize(
  t: TestClient,
  token: string,
  clientId: string,
  extra: Record<string, string> = {},
) {
  const { verifier, challenge } = await pkcePair()
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: "openid profile email",
    state: "etat-ch820",
    nonce: "nonce-ch820",
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...extra,
  })
  const res = await t.fetch(`/api/auth/oauth2/authorize?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const location = res.headers.get("location") ?? ""
  const url = location ? new URL(location) : null
  return { res, location, code: url?.searchParams.get("code") ?? null, verifier }
}

async function exchange(t: TestClient, clientId: string, code: string, verifier: string) {
  const res = await t.fetch("/api/auth/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      client_secret: CLIENT_SECRET,
      code_verifier: verifier,
    }).toString(),
  })
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { res, body }
}

const claimsOf = (jwt: string): Record<string, unknown> => {
  const part = jwt.split(".")[1] ?? ""
  const padded = part.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (part.length % 4)) % 4)
  return JSON.parse(atob(padded)) as Record<string, unknown>
}

async function countClients(t: TestClient) {
  return await t.run(async (ctx) => {
    const page = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
      model: "oauthApplication",
      paginationOpts: { numItems: 100, cursor: null },
    })) as { page: unknown[] }
    return page.page.length
  })
}

describe("inscription dynamique des clients (/oauth2/register)", () => {
  test("est refusée à une session ordinaire, sans rien créer", async () => {
    const t = makeTestClient()
    const { token } = await seedCitizen(t, 1)
    const res = await t.fetch("/api/auth/oauth2/register", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      // Le demandeur choisissait jusqu'ici les métadonnées : `env: production`
      // contournait le bac à sable et l'approbation d'un administrateur.
      body: JSON.stringify({
        client_name: "Hameçon",
        redirect_uris: ["https://hamecon.example/callback"],
        metadata: { env: "production", loa: 1 },
      }),
    })
    expect(res.status).toBe(403)
    expect(await countClients(t)).toBe(0)
  })

  test("est refusée sans session", async () => {
    const t = makeTestClient()
    const res = await t.fetch("/api/auth/oauth2/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "Anonyme", redirect_uris: ["https://x.example/cb"] }),
    })
    expect([401, 403]).toContain(res.status)
    expect(await countClients(t)).toBe(0)
  })

  test("n'est plus annoncée par la découverte OIDC", async () => {
    const t = makeTestClient()
    const res = await t.fetch("/api/auth/convex/.well-known/openid-configuration")
    expect(res.status).toBe(200)
    const discovery = (await res.json()) as Record<string, unknown>
    expect(discovery.registration_endpoint).toBeUndefined()
    expect(discovery.id_token_signing_alg_values_supported).toEqual(["RS256"])
  })
})

describe("niveau d'assurance contrôlé à l'émission", () => {
  test("client strict : refuse le jeton quand le compte est sous son minimum", async () => {
    const t = makeTestClient()
    const { userId, token } = await seedCitizen(t, 1)
    const clientId = await seedClient(t, { loa: 2, strict: true, consentFor: userId })
    // Client déjà consenti : Better Auth rend le code sans écran, c'est
    // l'émission du jeton qui refuse.
    const { code, verifier } = await authorize(t, token, clientId)
    expect(code).toBeTruthy()
    const { res, body } = await exchange(t, clientId, code as string, verifier)
    expect(res.status).toBe(403)
    expect(body.id_token).toBeUndefined()
    expect(body.access_token).toBeUndefined()
    expect(body.error).toBe("access_denied")
    expect(String(body.error_description)).toMatch(/^unmet_authentication_requirements: eidas2/)
  })

  test("client strict au niveau illisible : plancher 3", async () => {
    const t = makeTestClient()
    const { userId, token } = await seedCitizen(t, 2)
    const clientId = await seedClient(t, { loa: "illisible", strict: true, consentFor: userId })
    const { code, verifier } = await authorize(t, token, clientId)
    const { res, body } = await exchange(t, clientId, code as string, verifier)
    expect(res.status).toBe(403)
    expect(String(body.error_description)).toMatch(/eidas3/)
  })

  test("client strict : refuse un compte sans profil", async () => {
    const t = makeTestClient()
    const { userId, token } = await seedCitizen(t, null)
    const clientId = await seedClient(t, { loa: 1, strict: true, consentFor: userId })
    const { code, verifier } = await authorize(t, token, clientId)
    const { res } = await exchange(t, clientId, code as string, verifier)
    expect(res.status).toBe(403)
  })

  test("client progressif : jeton émis au niveau réel, que l'application vérifie", async () => {
    const t = makeTestClient()
    const { userId, token } = await seedCitizen(t, 1)
    const clientId = await seedClient(t, { loa: 2, consentFor: userId })
    const { code, verifier } = await authorize(t, token, clientId)
    const { res, body } = await exchange(t, clientId, code as string, verifier)
    expect(res.status).toBe(200)
    expect(claimsOf(String(body.id_token)).acr).toBe("eidas1")
  })

  test("acr_values reste une demande : le serveur émet le niveau réel", async () => {
    const t = makeTestClient()
    const { userId, token } = await seedCitizen(t, 2)
    const clientId = await seedClient(t, { loa: 1, consentFor: userId })
    const { code, verifier } = await authorize(t, token, clientId, { acr_values: "eidas3" })
    const { res, body } = await exchange(t, clientId, code as string, verifier)
    expect(res.status).toBe(200)
    expect(claimsOf(String(body.id_token)).acr).toBe("eidas2")
  })

  test("porte acr et loa dans l'ID token au niveau du compte, même sans le scope profile", async () => {
    const t = makeTestClient()
    const { userId, token } = await seedCitizen(t, 2)
    const clientId = await seedClient(t, {
      loa: 2,
      strict: true,
      consentFor: userId,
      scopes: ["openid"],
    })
    const { code, verifier } = await authorize(t, token, clientId, { scope: "openid" })
    expect(code).toBeTruthy()
    const { res, body } = await exchange(t, clientId, code as string, verifier)
    expect(res.status).toBe(200)
    const claims = claimsOf(String(body.id_token))
    expect(claims.acr).toBe("eidas2")
    expect(claims.loa).toBe(2)
    expect(claims.nonce).toBe("nonce-ch820")
    // auth_time n'est jamais émis en millisecondes.
    expect(claims.auth_time === undefined || Number(claims.auth_time) < 1e11).toBe(true)
  })

  test("compte sans profil sur un client progressif : acr « 0 » et loa 0", async () => {
    const t = makeTestClient()
    const { userId, token } = await seedCitizen(t, null)
    const clientId = await seedClient(t, { loa: 1, consentFor: userId })
    const { code, verifier } = await authorize(t, token, clientId)
    const { res, body } = await exchange(t, clientId, code as string, verifier)
    expect(res.status).toBe(200)
    const claims = claimsOf(String(body.id_token))
    expect(claims.acr).toBe("0")
    expect(claims.loa).toBe(0)
  })

  test("client strict : refuse userinfo si le compte est redescendu sous son minimum", async () => {
    const t = makeTestClient()
    const { userId, token } = await seedCitizen(t, 2)
    const clientId = await seedClient(t, { loa: 2, strict: true, consentFor: userId })
    const { code, verifier } = await authorize(t, token, clientId)
    const { body } = await exchange(t, clientId, code as string, verifier)
    expect(body.access_token).toBeTruthy()
    await setLevel(t, userId, 1)
    const res = await t.fetch("/api/auth/oauth2/userinfo", {
      headers: { Authorization: `Bearer ${String(body.access_token)}` },
    })
    expect(res.status).toBe(403)
  })

  test("bac à sable : un usager hors liste reçoit 403 access_denied, pas une erreur serveur", async () => {
    const t = makeTestClient()
    const { userId, token } = await seedCitizen(t, 2)
    const clientId = await seedClient(t, {
      loa: 1,
      env: "sandbox",
      testUsers: ["testeur.autorise@idn.ga"],
      consentFor: userId,
    })
    const { code, verifier } = await authorize(t, token, clientId)
    const { res, body } = await exchange(t, clientId, code as string, verifier)
    expect(res.status).toBe(403)
    expect(body.error).toBe("access_denied")
    expect(String(body.error_description)).toMatch(/^sandbox_access_denied/)
  })
})

describe("échange partenaire (/oauth2/partner-token-exchange)", () => {
  async function seedOneTimeToken(t: TestClient, sessionToken: string) {
    const subject = `ott-${Math.random().toString(36).slice(2)}`
    const now = Date.now()
    await t.run(async (ctx) => {
      await ctx.runMutation(components.betterAuth.adapter.create, {
        input: {
          model: "verification",
          data: {
            identifier: `one-time-token:${subject}`,
            value: sessionToken,
            expiresAt: now + 180_000,
            createdAt: now,
            updatedAt: now,
          },
        },
      })
    })
    return subject
  }

  async function countAccessTokens(t: TestClient) {
    return await t.run(async (ctx) => {
      const page = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
        model: "oauthAccessToken",
        paginationOpts: { numItems: 100, cursor: null },
      })) as { page: unknown[] }
      return page.page.length
    })
  }

  test("client strict : refuse sous son minimum sans écrire de jeton", async () => {
    const t = makeTestClient()
    const { userId, token } = await seedCitizen(t, 1)
    const clientId = await seedClient(t, { loa: 2, strict: true, consentFor: userId })
    vi.stubEnv("IDN_TOKEN_EXCHANGE_CLIENT_IDS", clientId)
    try {
      const subject = await seedOneTimeToken(t, token)
      const res = await t.fetch("/api/auth/oauth2/partner-token-exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: clientId, client_secret: CLIENT_SECRET, subject_token: subject }),
      })
      const body = (await res.json()) as Record<string, unknown>
      expect(res.status).toBe(403)
      expect(body.error).toBe("access_denied")
      expect(body.access_token).toBeUndefined()
      expect(await countAccessTokens(t)).toBe(0)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  test("client strict au niveau atteint : jeton et acr rendus", async () => {
    const t = makeTestClient()
    const { userId, token } = await seedCitizen(t, 2)
    const clientId = await seedClient(t, { loa: 2, strict: true, consentFor: userId })
    vi.stubEnv("IDN_TOKEN_EXCHANGE_CLIENT_IDS", clientId)
    try {
      const subject = await seedOneTimeToken(t, token)
      const res = await t.fetch("/api/auth/oauth2/partner-token-exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: clientId, client_secret: CLIENT_SECRET, subject_token: subject }),
      })
      const body = (await res.json()) as { access_token?: string; userinfo?: Record<string, unknown> }
      expect(res.status).toBe(200)
      expect(body.access_token).toBeTruthy()
      expect(body.userinfo?.acr).toBe("eidas2")
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe("rotation des clés de signature", () => {
  async function keyRows(t: TestClient) {
    return await t.run(async (ctx) => {
      const page = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
        model: "jwks",
        paginationOpts: { numItems: 100, cursor: null },
      })) as { page: Array<{ _id: string; publicKey: string; privateKey: string; createdAt: number }> }
      return page.page
    })
  }

  async function issueIdToken(t: TestClient, level: Level = 2) {
    const { userId, token } = await seedCitizen(t, level, `citoyen.${Math.random().toString(36).slice(2, 8)}@idn.ga`)
    const clientId = await seedClient(t, { loa: 1, consentFor: userId })
    const { code, verifier } = await authorize(t, token, clientId)
    return await exchange(t, clientId, code as string, verifier)
  }

  test("/oauth2/token signe avec la clé la plus récente quand deux clés coexistent", async () => {
    const t = makeTestClient()
    const first = await issueIdToken(t)
    expect(first.res.status).toBe(200)
    const [only] = await keyRows(t)
    expect(only).toBeTruthy()
    // Deuxième ligne, plus récente (même matière, autre identifiant) : c'est
    // l'état laissé par une rotation. L'adaptateur Convex rend createdAt en
    // nombre ; le tri de la clé la plus récente plantait (TypeError, 500).
    const newer = await t.run(async (ctx) =>
      (await ctx.runMutation(components.betterAuth.adapter.create, {
        input: {
          model: "jwks",
          data: { publicKey: only!.publicKey, privateKey: only!.privateKey, createdAt: only!.createdAt + 1000 },
        },
      })) as { _id: string },
    )
    const second = await issueIdToken(t)
    expect(second.res.status).toBe(200)
    const header = JSON.parse(atob(String(second.body.id_token).split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/")))
    expect(header.kid).toBe(newer._id)
  })

  async function publishedJwks(t: TestClient) {
    const res = await t.fetch("/api/auth/convex/jwks")
    expect(res.status).toBe(200)
    return (await res.json()) as { keys: Array<{ kid: string; alg: string; n: string }> }
  }

  const kidOf = (jwt: string) =>
    JSON.parse(atob(jwt.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/"))).kid as string

  async function verifyAgainstPublished(t: TestClient, jwt: string, audience: string) {
    const jwks = createLocalJWKSet(await publishedJwks(t))
    return await jwtVerify(jwt, jwks, { algorithms: ["RS256"], audience })
  }

  async function issueFor(t: TestClient) {
    const { userId, token } = await seedCitizen(t, 2, `citoyen.${Math.random().toString(36).slice(2, 8)}@idn.ga`)
    const clientId = await seedClient(t, { loa: 1, consentFor: userId })
    const { code, verifier } = await authorize(t, token, clientId)
    const { body } = await exchange(t, clientId, code as string, verifier)
    return { idToken: String(body.id_token), clientId, sessionToken: token }
  }

  test("rotation : les jetons de l'ancienne clé restent valides, les nouveaux portent la nouvelle", async () => {
    const t = makeTestClient()
    const before = await issueFor(t)
    const kidA = kidOf(before.idToken)
    expect((await publishedJwks(t)).keys.map((k) => k.kid)).toEqual([kidA])

    const rotated = await t.action(internal.jwksRotation.rotate, { force: true })
    expect(rotated.rotated).toBe(true)
    const kidB = rotated.kid as string
    expect(kidB).not.toBe(kidA)

    // Les deux clés sont publiées, en RS256 ; la nouvelle est RSA 3072.
    const jwks = await publishedJwks(t)
    expect(jwks.keys.map((k) => k.kid).sort()).toEqual([kidA, kidB].sort())
    expect(jwks.keys.every((k) => k.alg === "RS256")).toBe(true)
    const listed = await t.action(internal.jwksRotation.list, {})
    expect(listed[0]).toMatchObject({ kid: kidB, active: true, modulusBits: 3072 })

    // Jeton de A, émis avant la rotation : toujours accepté.
    await expect(verifyAgainstPublished(t, before.idToken, before.clientId)).resolves.toBeTruthy()
    // Nouvel ID token et nouveau JWT Convex : signés par B, acceptés.
    const after = await issueFor(t)
    expect(kidOf(after.idToken)).toBe(kidB)
    await expect(verifyAgainstPublished(t, after.idToken, after.clientId)).resolves.toBeTruthy()
    const convexToken = await t.fetch("/api/auth/convex/token", {
      headers: { Authorization: `Bearer ${after.sessionToken}` },
    })
    expect(convexToken.status).toBe(200)
    const { token: convexJwt } = (await convexToken.json()) as { token: string }
    expect(kidOf(convexJwt)).toBe(kidB)
    await expect(verifyAgainstPublished(t, convexJwt, "convex")).resolves.toBeTruthy()

    // Purge immédiate : rien, A reste publiée 7 jours.
    expect((await t.action(internal.jwksRotation.prune, {})).pruned).toEqual([])
    // Sans geste forcé ni rotation armée, rien ne tourne.
    expect((await t.action(internal.jwksRotation.rotate, {})).rotated).toBe(false)
  })

  test("révocation : la clé retirée n'est plus publiée, la clé active exige une confirmation", async () => {
    const t = makeTestClient()
    const before = await issueFor(t)
    const kidA = kidOf(before.idToken)
    const { kid: kidB } = await t.action(internal.jwksRotation.rotate, { force: true })

    await t.action(internal.jwksRotation.revoke, { kid: kidA })
    expect((await publishedJwks(t)).keys.map((k) => k.kid)).toEqual([kidB])
    await expect(verifyAgainstPublished(t, before.idToken, before.clientId)).rejects.toThrow()

    await expect(t.action(internal.jwksRotation.revoke, { kid: kidB as string })).rejects.toThrow(
      /confirmLatest/,
    )
    const last = await t.action(internal.jwksRotation.revoke, { kid: kidB as string, confirmLatest: true })
    expect(last.replacement).toBeTruthy()
    // Jamais de JWKS vide.
    expect((await publishedJwks(t)).keys.map((k) => k.kid)).toEqual([last.replacement])
  })

  test("aucune source n'appelle la rotation destructrice du plugin convex", async () => {
    const sources = import.meta.glob("/convex/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<
      string,
      string
    >
    const offenders = Object.entries(sources)
      .filter(([path]) => !path.includes("/_generated/") && !path.endsWith(".test.ts"))
      .filter(([, code]) => /\brotateKeys\b|jwksRotateOnTokenGenerationError|rotate-keys/.test(code))
      .map(([path]) => path)
    expect(offenders).toEqual([])
  })
})
