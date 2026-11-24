/// <reference types="vite/client" />
import { register as registerAggregate } from "@convex-dev/aggregate/test"
import { register as registerBetterAuth } from "@convex-dev/better-auth/test"
import { convexTest } from "convex-test"
import { describe, expect, test } from "vitest"

import { components } from "./_generated/api"
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
async function seedCitizen(t: TestClient, loa: Level, email = "citoyen.ordinaire@idn.ga") {
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
    await ctx.db.insert("userProfile", {
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
  opts: { loa: Level; clientId?: string; consentFor?: string; scopes?: string[] },
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
            env: "production",
            loa: opts.loa,
            description: "",
            scopes,
            createdBy: "",
            services: [],
            testUsers: [],
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
  test("refuse le jeton quand le compte est sous le minimum du client", async () => {
    const t = makeTestClient()
    const { userId, token } = await seedCitizen(t, 1)
    const clientId = await seedClient(t, { loa: 2, consentFor: userId })
    const { code, verifier, location } = await authorize(t, token, clientId)
    // Le contrôle ne vit plus seulement dans l'écran de consentement : un
    // client déjà consenti reçoit le code sans écran, l'émission refuse.
    if (code) {
      const { res, body } = await exchange(t, clientId, code, verifier)
      expect(res.status).toBe(403)
      expect(body.id_token).toBeUndefined()
      expect(body.error).toBe("access_denied")
    } else {
      expect(location).toMatch(/error=access_denied/)
    }
  })

  test("refuse le jeton quand acr_values exige plus que le compte", async () => {
    const t = makeTestClient()
    const { userId, token } = await seedCitizen(t, 2)
    const clientId = await seedClient(t, { loa: 1, consentFor: userId })
    const { code, verifier, location } = await authorize(t, token, clientId, { acr_values: "eidas3" })
    if (code) {
      const { res, body } = await exchange(t, clientId, code, verifier)
      expect(res.status).toBe(403)
      expect(body.id_token).toBeUndefined()
    } else {
      expect(location).toMatch(/error=access_denied/)
    }
  })

  test("porte acr et loa dans l'ID token au niveau du compte, même sans le scope profile", async () => {
    const t = makeTestClient()
    const { userId, token } = await seedCitizen(t, 2)
    const clientId = await seedClient(t, { loa: 2, consentFor: userId, scopes: ["openid"] })
    const { code, verifier } = await authorize(t, token, clientId, { scope: "openid" })
    expect(code).toBeTruthy()
    const { res, body } = await exchange(t, clientId, code as string, verifier)
    expect(res.status).toBe(200)
    const claims = claimsOf(String(body.id_token))
    expect(claims.acr).toBe("eidas2")
    expect(claims.loa).toBe(2)
    expect(claims.nonce).toBe("nonce-ch820")
  })

  test("refuse userinfo si le compte est redescendu sous le minimum du client", async () => {
    const t = makeTestClient()
    const { userId, token } = await seedCitizen(t, 2)
    const clientId = await seedClient(t, { loa: 2, consentFor: userId })
    const { code, verifier } = await authorize(t, token, clientId)
    const { body } = await exchange(t, clientId, code as string, verifier)
    expect(body.access_token).toBeTruthy()
    await setLevel(t, userId, 1)
    const res = await t.fetch("/api/auth/oauth2/userinfo", {
      headers: { Authorization: `Bearer ${String(body.access_token)}` },
    })
    expect(res.status).toBe(403)
  })
})
