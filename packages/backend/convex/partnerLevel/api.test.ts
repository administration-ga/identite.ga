/// <reference types="vite/client" />
import { register as registerAggregate } from "@convex-dev/aggregate/test"
import { register as registerBetterAuth } from "@convex-dev/better-auth/test"
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test"
import { convexTest } from "convex-test"
import { describe, expect, test } from "vitest"

import { components, internal } from "../_generated/api"
import { hashClientSecret } from "../lib/partnerClientAuth"
import { PARTNER_LEVEL_ATTEST_CAPACITY, rateLimiter } from "../rateLimiter"
import schema from "../schema"

const modules = import.meta.glob("/convex/**/*.ts")

/**
 * Contrat HTTP `IDN-ATTESTATION-NIVEAU-V1` : `/partner-level/v1/attestations`
 * et `/partner-level/v1/attestations/withdraw`.
 *
 * CE QUI EST EN JEU : c'est le corps JSON et le statut HTTP qui font contrat
 * avec le partenaire. Aucun validateur Convex ne les protège : ils sont
 * construits à la main dans `partnerLevel/http.ts`. On y vérifie aussi que
 * rien d'interne ne traverse (ni identifiant Convex, ni état civil), et
 * l'ordre des refus : un appelant anonyme ne doit pas apprendre quels clients
 * sont habilités (401 avant 403).
 */

const CLIENT = "consulat-ga"
const SECRET = "secret-du-consulat"
const ATTEST = "/partner-level/v1/attestations"
const WITHDRAW = "/partner-level/v1/attestations/withdraw"

function makeT() {
  const t = convexTest(schema, modules)
  registerAggregate(t, "kycByStatus")
  registerAggregate(t, "usersByLoa")
  registerAggregate(t, "usersByProfile")
  registerRateLimiter(t)
  registerBetterAuth(t)
  return t
}
type T = ReturnType<typeof makeT>

function basic(clientId: string, secret: string): string {
  return `Basic ${btoa(`${clientId}:${secret}`)}`
}

async function seedClient(t: T) {
  const clientSecret = await hashClientSecret(SECRET)
  await t.run(async (ctx) => {
    await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "oauthApplication",
        data: {
          clientId: CLIENT,
          clientSecret,
          name: "Consulat.ga",
          type: "web",
          disabled: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    })
  })
}

async function enable(t: T) {
  await t.mutation(internal.partnerLevel.attestations.grantCapability, {
    clientId: CLIENT,
    kind: "consular_registration",
    grantedBy: "opérateur de test",
  })
}

async function seedCitizen(
  t: T,
  userId: string,
  opts: { profileType?: "citizen" | "visitor"; consent?: boolean } = {},
) {
  const now = Date.now()
  await t.run(async (ctx) => {
    await ctx.db.insert("userProfile", {
      userId,
      profileType: opts.profileType ?? "citizen",
      loa: 1,
      idnId: "GA-0001-0001",
      pivot: {
        firstName: "Awa",
        lastName: "MBINA",
        dateOfBirth: "1995-03-12",
        gender: "F",
        birthPlace: "Port-Gentil",
        nationality: "GA",
      },
      createdAt: now,
      updatedAt: now,
    })
    await ctx.db.insert("notificationPreference", {
      userId,
      email: { security: true, kyc: false, consent: true, comms: true },
      inApp: { security: true, kyc: true, consent: true, comms: true },
      updatedAt: now,
    })
    if (opts.consent !== false) {
      await ctx.runMutation(components.betterAuth.adapter.create, {
        input: {
          model: "oauthConsent",
          data: {
            clientId: CLIENT,
            userId,
            scopes: "openid profile",
            consentGiven: true,
            createdAt: now,
            updatedAt: now,
          },
        },
      })
    }
  })
}

function post(
  t: T,
  path: string,
  body: unknown,
  authorization: string | null = basic(CLIENT, SECRET),
) {
  return t.fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body: JSON.stringify(body),
  })
}

const BODY = { sub: "citizen_a", kind: "consular_registration" }

describe("authentification et capacité", () => {
  test("sans en-tête Basic : 401 invalid_client", async () => {
    const t = makeT()
    await seedClient(t)
    const res = await post(t, ATTEST, BODY, null)
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: "invalid_client" })
  })

  test("mauvais secret : 401, que le client soit habilité ou non", async () => {
    const t = makeT()
    await seedClient(t)
    await seedCitizen(t, "citizen_a")

    // Client SANS capacité : un 403 révélerait qu'il existe et n'est pas habilité.
    const before = await post(t, ATTEST, BODY, basic(CLIENT, "mauvais-secret"))
    expect(before.status).toBe(401)
    expect(await before.json()).toMatchObject({ error: "invalid_client" })

    await enable(t)
    const after = await post(t, ATTEST, BODY, basic(CLIENT, "mauvais-secret"))
    expect(after.status).toBe(401)

    const unknown = await post(t, ATTEST, BODY, basic("client-inconnu", SECRET))
    expect(unknown.status).toBe(401)
  })

  test("bon secret sans capacité : 403 attestation_not_enabled", async () => {
    const t = makeT()
    await seedClient(t)
    await seedCitizen(t, "citizen_a")
    const res = await post(t, ATTEST, BODY)
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: "attestation_not_enabled" })
  })

  test("capacité fermée : 403 de nouveau", async () => {
    const t = makeT()
    await seedClient(t)
    await enable(t)
    await seedCitizen(t, "citizen_a")
    await t.mutation(internal.partnerLevel.attestations.revokeCapability, {
      clientId: CLIENT,
      kind: "consular_registration",
      revokedBy: "opérateur de test",
    })
    const res = await post(t, ATTEST, BODY)
    expect(res.status).toBe(403)
  })
})

describe("POST /partner-level/v1/attestations", () => {
  test("200 applied : corps exact, sans rien d'interne", async () => {
    const t = makeT()
    await seedClient(t)
    await enable(t)
    await seedCitizen(t, "citizen_a")

    const res = await post(t, ATTEST, BODY)

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(
      ["acr", "attestedAt", "dryRun", "loa", "outcome"].sort(),
    )
    expect(body).toMatchObject({ outcome: "applied", loa: 2, acr: "eidas2", dryRun: false })
    expect(typeof body.attestedAt).toBe("number")
    const raw = JSON.stringify(body)
    expect(raw).not.toContain("MBINA")
    expect(raw).not.toContain("GA-0001-0001")
  })

  test("une seconde attestation répond already_attested", async () => {
    const t = makeT()
    await seedClient(t)
    await enable(t)
    await seedCitizen(t, "citizen_a")
    await post(t, ATTEST, BODY)

    const res = await post(t, ATTEST, BODY)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ outcome: "already_attested", loa: 2 })
  })

  test("dryRun : 200 avec dryRun vrai, niveau inchangé en base", async () => {
    const t = makeT()
    await seedClient(t)
    await enable(t)
    await seedCitizen(t, "citizen_a")

    const res = await post(t, ATTEST, { ...BODY, dryRun: true })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ outcome: "applied", dryRun: true })
    const profile = await t.run(async (ctx) =>
      ctx.db
        .query("userProfile")
        .withIndex("by_userId", (q) => q.eq("userId", "citizen_a"))
        .unique(),
    )
    expect(profile?.loa).toBe(1)
  })

  test("champ en trop ou JSON invalide : 400 invalid_request", async () => {
    const t = makeT()
    await seedClient(t)
    await enable(t)
    const extra = await post(t, ATTEST, { ...BODY, loa: 2 })
    expect(extra.status).toBe(400)
    expect(await extra.json()).toMatchObject({ error: "invalid_request" })

    const broken = await t.fetch(ATTEST, {
      method: "POST",
      headers: { Authorization: basic(CLIENT, SECRET) },
      body: "{pas du json",
    })
    expect(broken.status).toBe(400)
  })

  test("refus métier : 404, 409 not_linked, 422 avec motif", async () => {
    const t = makeT()
    await seedClient(t)
    await enable(t)
    await seedCitizen(t, "citizen_nolink", { consent: false })
    await seedCitizen(t, "visitor_a", { profileType: "visitor" })

    const unknown = await post(t, ATTEST, { ...BODY, sub: "personne" })
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toMatchObject({ error: "unknown_subject" })

    const notLinked = await post(t, ATTEST, { ...BODY, sub: "citizen_nolink" })
    expect(notLinked.status).toBe(409)
    expect(await notLinked.json()).toMatchObject({ error: "not_linked" })

    const visitor = await post(t, ATTEST, { ...BODY, sub: "visitor_a" })
    expect(visitor.status).toBe(422)
    expect(await visitor.json()).toMatchObject({
      error: "not_eligible",
      reason: "profile_type",
    })
  })

  test("revue humaine requise : 409 review_required avec motif", async () => {
    const t = makeT()
    await seedClient(t)
    await enable(t)
    await seedCitizen(t, "citizen_a")
    await t.run(async (ctx) => {
      const now = Date.now()
      await ctx.db.insert("kycRequest", {
        userId: "citizen_a",
        documentType: "passport",
        documentImages: {},
        status: "rejected",
        createdAt: now,
        updatedAt: now,
      })
    })

    const res = await post(t, ATTEST, BODY)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({
      error: "review_required",
      reason: "kyc_rejected",
    })
  })

  test("plafond atteint : 429 rate_limited avec Retry-After", async () => {
    const t = makeT()
    await seedClient(t)
    await enable(t)
    await seedCitizen(t, "citizen_a")
    await t.run(async (ctx) => {
      await rateLimiter.limit(ctx, "partnerLevelAttest", {
        key: CLIENT,
        count: PARTNER_LEVEL_ATTEST_CAPACITY,
      })
    })

    const res = await post(t, ATTEST, BODY)
    expect(res.status).toBe(429)
    expect(await res.json()).toMatchObject({ error: "rate_limited" })
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0)
  })
})

describe("POST /partner-level/v1/attestations/withdraw", () => {
  test("200 withdrawn : niveau ramené, corps exact", async () => {
    const t = makeT()
    await seedClient(t)
    await enable(t)
    await seedCitizen(t, "citizen_a")
    await post(t, ATTEST, BODY)

    const res = await post(t, WITHDRAW, { ...BODY, dryRun: false })

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(["acr", "dryRun", "loa", "outcome"].sort())
    expect(body).toEqual({ outcome: "withdrawn", loa: 1, acr: "eidas1", dryRun: false })
  })

  test("sans attestation active : 200 not_attested", async () => {
    const t = makeT()
    await seedClient(t)
    await enable(t)
    await seedCitizen(t, "citizen_a")
    const res = await post(t, WITHDRAW, BODY)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ outcome: "not_attested", loa: 1 })
  })

  test("mauvais secret : 401 ; champ en trop : 400", async () => {
    const t = makeT()
    await seedClient(t)
    await enable(t)
    expect((await post(t, WITHDRAW, BODY, basic(CLIENT, "faux"))).status).toBe(401)
    expect((await post(t, WITHDRAW, { ...BODY, reason: "x" })).status).toBe(400)
  })
})
