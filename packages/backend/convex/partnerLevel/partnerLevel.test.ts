/// <reference types="vite/client" />
import { register as registerAggregate } from "@convex-dev/aggregate/test"
import { register as registerBetterAuth } from "@convex-dev/better-auth/test"
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test"
import { ConvexError } from "convex/values"
import { convexTest } from "convex-test"
import { describe, expect, test } from "vitest"

import { components, internal } from "../_generated/api"
import { usersByLoa } from "../aggregates"
import { PARTNER_LEVEL_ATTEST_CAPACITY, rateLimiter } from "../rateLimiter"
import schema from "../schema"

const modules = import.meta.glob("/convex/**/*.ts")

/**
 * Attestation de niveau par un partenaire (contrat IDN-ATTESTATION-NIVEAU-V1,
 * ADR 0003), au niveau des fonctions internes appelées par la route HTTP.
 *
 * CE QUI EST EN JEU : un consulat atteste qu'un ressortissant a ouvert son
 * inscription consulaire ; IDN relève alors son compte au Niveau 2, l'écrit
 * lui-même, le trace et prévient la personne. Le retrait ne redescend qu'au
 * niveau d'avant, et jamais quand une autre preuve soutient le niveau.
 *
 * Le composant Better Auth tourne ici (`registerBetterAuth`) : le client OAuth
 * et le consentement sont lus là où la production les lit.
 */

const CLIENT = "consulat-ga"
const OTHER_CLIENT = "diplomate-ga"
const KIND = "consular_registration" as const

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

async function seedClient(
  t: T,
  clientId: string,
  opts: { type?: string; disabled?: boolean; name?: string } = {},
) {
  await t.run(async (ctx) => {
    await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "oauthApplication",
        data: {
          clientId,
          clientSecret: "empreinte-du-secret",
          name: opts.name ?? "Consulat.ga",
          type: opts.type ?? "web",
          disabled: opts.disabled ?? false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    })
  })
}

async function enable(t: T, clientId = CLIENT) {
  await seedClient(t, clientId, {
    name: clientId === CLIENT ? "Consulat.ga" : "Diplomate.ga",
  })
  return await t.mutation(internal.partnerLevel.attestations.grantCapability, {
    clientId,
    kind: KIND,
    grantedBy: "opérateur de test",
  })
}

async function seedCitizen(
  t: T,
  userId: string,
  opts: {
    loa?: 1 | 2 | 3
    profileType?: "citizen" | "resident" | "visitor" | "developer"
    withPivot?: boolean
    closing?: boolean
    deleted?: boolean
  } = {},
) {
  const now = Date.now()
  await t.run(async (ctx) => {
    await ctx.db.insert("userProfile", {
      userId,
      profileType: opts.profileType ?? "citizen",
      loa: opts.loa ?? 1,
      ...(opts.withPivot === false
        ? {}
        : {
            pivot: {
              firstName: "Awa",
              lastName: "MBINA",
              dateOfBirth: "1995-03-12",
              gender: "F" as const,
              birthPlace: "Port-Gentil",
              nationality: "GA",
            },
          }),
      ...(opts.closing
        ? { deletionRequestedAt: now, deletionScheduledAt: now + 1000 }
        : {}),
      ...(opts.deleted ? { deletedAt: now } : {}),
      createdAt: now,
      updatedAt: now,
    })
    // Courriel coupé pour la catégorie « kyc » : le test n'a pas de serveur
    // de courrier ; la notification dans l'application reste active.
    await ctx.db.insert("notificationPreference", {
      userId,
      email: { security: true, kyc: false, consent: true, comms: true },
      inApp: { security: true, kyc: true, consent: true, comms: true },
      updatedAt: now,
    })
  })
}

async function seedConsent(
  t: T,
  userId: string,
  clientId = CLIENT,
  consentGiven = true,
) {
  await t.run(async (ctx) => {
    await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "oauthConsent",
        data: {
          clientId,
          userId,
          scopes: "openid profile",
          consentGiven,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    })
  })
}

function attest(
  t: T,
  sub: string,
  opts: { clientId?: string; dryRun?: boolean } = {},
) {
  return t.mutation(internal.partnerLevel.attestations.attest, {
    clientId: opts.clientId ?? CLIENT,
    clientName: opts.clientId === OTHER_CLIENT ? "Diplomate.ga" : "Consulat.ga",
    sub,
    kind: KIND,
    dryRun: opts.dryRun ?? false,
  })
}

function withdraw(
  t: T,
  sub: string,
  opts: { clientId?: string; dryRun?: boolean } = {},
) {
  return t.mutation(internal.partnerLevel.attestations.withdraw, {
    clientId: opts.clientId ?? CLIENT,
    clientName: opts.clientId === OTHER_CLIENT ? "Diplomate.ga" : "Consulat.ga",
    sub,
    kind: KIND,
    dryRun: opts.dryRun ?? false,
  })
}

async function profileOf(t: T, userId: string) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("userProfile")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique(),
  )
}

async function attestationsOf(t: T, userId: string) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("levelAttestation")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect(),
  )
}

async function auditsOf(t: T, action: string) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("auditLog").collect()).filter((row) => row.action === action),
  )
}

async function notificationsOf(t: T, userId: string) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("notification")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect(),
  )
}

/** Citoyen éligible, consentement donné au consulat, capacité ouverte. */
async function readyCitizen(t: T, userId = "citizen_a", loa: 1 | 2 | 3 = 1) {
  await enable(t)
  await seedCitizen(t, userId, { loa })
  await seedConsent(t, userId)
}

describe("capacité d'un client (fermée par défaut)", () => {
  test("ouvrir la capacité rend le nom du client, est idempotent et tracé", async () => {
    const t = makeT()
    await seedClient(t, CLIENT, { name: "Consulat.ga" })

    const first = await t.mutation(internal.partnerLevel.attestations.grantCapability, {
      clientId: CLIENT,
      kind: KIND,
      grantedBy: "opérateur",
    })
    const second = await t.mutation(internal.partnerLevel.attestations.grantCapability, {
      clientId: CLIENT,
      kind: KIND,
      grantedBy: "opérateur",
    })

    expect(first).toEqual({ clientName: "Consulat.ga", status: "granted" })
    expect(second).toEqual({ clientName: "Consulat.ga", status: "already_granted" })
    const grants = await t.run(async (ctx) => ctx.db.query("partnerLevelGrant").collect())
    expect(grants).toHaveLength(1)
    expect(grants[0]).toMatchObject({ clientId: CLIENT, kind: KIND, maxLoa: 2 })
    const audits = await auditsOf(t, "admin_action")
    expect(audits).toHaveLength(1)
    expect(audits[0]!.metadata).toMatchObject({
      kind: "partner_level_capability_granted",
      clientId: CLIENT,
    })
  })

  test("un client absent, public ou désactivé ne reçoit pas la capacité", async () => {
    const t = makeT()
    await seedClient(t, "client-public", { type: "public" })
    await seedClient(t, "client-coupe", { disabled: true })

    for (const clientId of ["client-absent", "client-public", "client-coupe"]) {
      await expect(
        t.mutation(internal.partnerLevel.attestations.grantCapability, {
          clientId,
          kind: KIND,
          grantedBy: "opérateur",
        }),
      ).rejects.toThrow(ConvexError)
    }
    const grants = await t.run(async (ctx) => ctx.db.query("partnerLevelGrant").collect())
    expect(grants).toHaveLength(0)
  })

  test("sans capacité, l'attestation est refusée (attestation_not_enabled)", async () => {
    const t = makeT()
    await seedClient(t, CLIENT)
    await seedCitizen(t, "citizen_a")
    await seedConsent(t, "citizen_a")

    expect(await attest(t, "citizen_a")).toEqual({
      ok: false,
      error: "attestation_not_enabled",
    })
    expect((await profileOf(t, "citizen_a"))?.loa).toBe(1)
  })

  test("une capacité fermée refuse de nouveau (attestation_not_enabled)", async () => {
    const t = makeT()
    await readyCitizen(t)
    expect(
      await t.mutation(internal.partnerLevel.attestations.revokeCapability, {
        clientId: CLIENT,
        kind: KIND,
        revokedBy: "opérateur",
      }),
    ).toEqual({ status: "revoked" })

    expect(await attest(t, "citizen_a")).toEqual({
      ok: false,
      error: "attestation_not_enabled",
    })
    expect(await withdraw(t, "citizen_a")).toEqual({
      ok: false,
      error: "attestation_not_enabled",
    })
  })
})

describe("attestation", () => {
  test("un citoyen au Niveau 1 passe au Niveau 2, l'agrégat suit, la personne est prévenue", async () => {
    const t = makeT()
    await readyCitizen(t)

    const result = await attest(t, "citizen_a")

    expect(result).toMatchObject({
      ok: true,
      outcome: "applied",
      loa: 2,
      acr: "eidas2",
      dryRun: false,
    })
    expect((await profileOf(t, "citizen_a"))?.loa).toBe(2)
    // L'écriture passe par les déclencheurs de `functions.ts` : sans eux,
    // l'agrégat du tableau de bord compterait encore ce compte au Niveau 1.
    const atLevel2 = await t.run((ctx) =>
      usersByLoa.count(ctx, {
        bounds: { lower: { key: 2, inclusive: true }, upper: { key: 2, inclusive: true } },
      }),
    )
    expect(atLevel2).toBe(1)

    const rows = await attestationsOf(t, "citizen_a")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      clientId: CLIENT,
      kind: KIND,
      status: "active",
      previousLoa: 1,
      raised: true,
    })
    const audits = await auditsOf(t, "level_attested")
    expect(audits).toHaveLength(1)
    expect(audits[0]!.metadata).toMatchObject({
      clientId: CLIENT,
      kind: KIND,
      outcome: "applied",
      previousLoa: 1,
      loa: 2,
    })
    const notifications = await notificationsOf(t, "citizen_a")
    expect(notifications).toHaveLength(1)
    expect(notifications[0]!.title).toContain("Niveau 2")
  })

  test("une seconde attestation ne refait rien (already_attested)", async () => {
    const t = makeT()
    await readyCitizen(t)
    const first = await attest(t, "citizen_a")
    const second = await attest(t, "citizen_a")

    expect(second).toMatchObject({ ok: true, outcome: "already_attested", loa: 2 })
    if (first.ok && second.ok) expect(second.attestedAt).toBe(first.attestedAt)
    expect(await attestationsOf(t, "citizen_a")).toHaveLength(1)
    expect(await auditsOf(t, "level_attested")).toHaveLength(1)
    expect(await notificationsOf(t, "citizen_a")).toHaveLength(1)
  })

  test("dryRun évalue tout et n'écrit rien", async () => {
    const t = makeT()
    await readyCitizen(t)

    const result = await attest(t, "citizen_a", { dryRun: true })

    expect(result).toMatchObject({ ok: true, outcome: "applied", loa: 2, dryRun: true })
    expect((await profileOf(t, "citizen_a"))?.loa).toBe(1)
    expect(await attestationsOf(t, "citizen_a")).toHaveLength(0)
    expect(await auditsOf(t, "level_attested")).toHaveLength(0)
    expect(await notificationsOf(t, "citizen_a")).toHaveLength(0)
  })

  test("un dryRun refusé n'écrit pas non plus de trace de refus", async () => {
    const t = makeT()
    await enable(t)
    await seedCitizen(t, "citizen_a")

    expect(await attest(t, "citizen_a", { dryRun: true })).toEqual({
      ok: false,
      error: "not_linked",
    })
    expect(await auditsOf(t, "level_attestation_refused")).toHaveLength(0)
  })

  test("un Niveau 3 n'est jamais abaissé : simple trace (recorded)", async () => {
    const t = makeT()
    await readyCitizen(t, "citizen_l3", 3)

    expect(await attest(t, "citizen_l3")).toMatchObject({
      ok: true,
      outcome: "recorded",
      loa: 3,
      acr: "eidas3",
    })
    expect((await profileOf(t, "citizen_l3"))?.loa).toBe(3)
    expect(await attestationsOf(t, "citizen_l3")).toMatchObject([
      { status: "active", previousLoa: 3, raised: false },
    ])
    // Rien n'a changé pour la personne : pas de notification.
    expect(await notificationsOf(t, "citizen_l3")).toHaveLength(0)
  })

  test("sans consentement enregistré pour ce client : not_linked, refus tracé", async () => {
    const t = makeT()
    await enable(t)
    await seedCitizen(t, "citizen_a")
    // Un consentement retiré (`consentGiven: false`) ne compte pas.
    await seedConsent(t, "citizen_a", CLIENT, false)
    // Un consentement donné à un AUTRE client ne compte pas non plus.
    await seedConsent(t, "citizen_a", OTHER_CLIENT)

    expect(await attest(t, "citizen_a")).toEqual({ ok: false, error: "not_linked" })
    expect((await profileOf(t, "citizen_a"))?.loa).toBe(1)
    const refusals = await auditsOf(t, "level_attestation_refused")
    expect(refusals).toHaveLength(1)
    expect(refusals[0]!.metadata).toMatchObject({
      clientId: CLIENT,
      error: "not_linked",
      operation: "attest",
    })
  })

  test("sujet inconnu, sans profil ou anonymisé : unknown_subject", async () => {
    const t = makeT()
    await enable(t)
    await seedCitizen(t, "citizen_gone", { deleted: true })
    await seedConsent(t, "citizen_gone")

    expect(await attest(t, "personne")).toEqual({ ok: false, error: "unknown_subject" })
    expect(await attest(t, "citizen_gone")).toEqual({
      ok: false,
      error: "unknown_subject",
    })
  })

  test("dernière demande KYC refusée : review_required / kyc_rejected", async () => {
    const t = makeT()
    await readyCitizen(t)
    await t.run(async (ctx) => {
      const now = Date.now()
      await ctx.db.insert("kycRequest", {
        userId: "citizen_a",
        documentType: "passport",
        documentImages: {},
        status: "rejected",
        rejectionReason: "Pièce illisible",
        createdAt: now,
        updatedAt: now,
      })
    })

    expect(await attest(t, "citizen_a")).toEqual({
      ok: false,
      error: "review_required",
      reason: "kyc_rejected",
    })
    expect((await profileOf(t, "citizen_a"))?.loa).toBe(1)
    const refusals = await auditsOf(t, "level_attestation_refused")
    expect(refusals[0]!.metadata).toMatchObject({
      error: "review_required",
      reason: "kyc_rejected",
    })
    // Aucune donnée d'état civil dans la trace.
    expect(JSON.stringify(refusals[0]!.metadata)).not.toContain("MBINA")
  })

  test("signalement de doublon ouvert : review_required / duplicate_flag_open", async () => {
    const t = makeT()
    await readyCitizen(t)
    await t.run(async (ctx) => {
      await ctx.db.insert("duplicateSignal", {
        userId: "citizen_a",
        matchedUserId: "autre",
        signal: "pivot",
        groupKey: "mbina|awa|1995-03-12",
        status: "open",
        detectedAt: Date.now(),
      })
    })

    expect(await attest(t, "citizen_a")).toEqual({
      ok: false,
      error: "review_required",
      reason: "duplicate_flag_open",
    })
  })

  test("visiteur, profil incomplet ou compte en fermeture : not_eligible", async () => {
    const t = makeT()
    await enable(t)
    await seedCitizen(t, "visitor_a", { profileType: "visitor" })
    await seedCitizen(t, "incomplete_a", { withPivot: false })
    await seedCitizen(t, "closing_a", { closing: true })
    for (const userId of ["visitor_a", "incomplete_a", "closing_a"]) {
      await seedConsent(t, userId)
    }

    expect(await attest(t, "visitor_a")).toEqual({
      ok: false,
      error: "not_eligible",
      reason: "profile_type",
    })
    expect(await attest(t, "incomplete_a")).toEqual({
      ok: false,
      error: "not_eligible",
      reason: "profile_incomplete",
    })
    expect(await attest(t, "closing_a")).toEqual({
      ok: false,
      error: "not_eligible",
      reason: "account_closing",
    })
  })

  test("au-delà du plafond du client : rate_limited", async () => {
    const t = makeT()
    await readyCitizen(t)
    await t.run(async (ctx) => {
      await rateLimiter.limit(ctx, "partnerLevelAttest", {
        key: CLIENT,
        count: PARTNER_LEVEL_ATTEST_CAPACITY,
      })
    })

    const result = await attest(t, "citizen_a")
    expect(result).toMatchObject({ ok: false, error: "rate_limited" })
    expect((await profileOf(t, "citizen_a"))?.loa).toBe(1)
  })
})

describe("retrait", () => {
  test("le retrait de l'attestation qui avait monté le compte le ramène au Niveau 1", async () => {
    const t = makeT()
    await readyCitizen(t)
    await attest(t, "citizen_a")

    const result = await withdraw(t, "citizen_a")

    expect(result).toEqual({
      ok: true,
      outcome: "withdrawn",
      loa: 1,
      acr: "eidas1",
      dryRun: false,
    })
    expect((await profileOf(t, "citizen_a"))?.loa).toBe(1)
    expect(await attestationsOf(t, "citizen_a")).toMatchObject([
      { status: "withdrawn" },
    ])
    const audits = await auditsOf(t, "level_attestation_withdrawn")
    expect(audits).toHaveLength(1)
    expect(audits[0]!.metadata).toMatchObject({ outcome: "withdrawn", loa: 1 })
    const notifications = await notificationsOf(t, "citizen_a")
    expect(notifications).toHaveLength(2)
    expect(notifications.map((n) => n.title).join(" ")).toContain("Niveau 1")
  })

  test("une demande KYC approuvée garde le niveau (kept)", async () => {
    const t = makeT()
    await readyCitizen(t)
    await attest(t, "citizen_a")
    await t.run(async (ctx) => {
      const now = Date.now()
      await ctx.db.insert("kycRequest", {
        userId: "citizen_a",
        documentType: "passport",
        documentImages: {},
        status: "approved",
        reviewedAt: now,
        createdAt: now,
        updatedAt: now,
      })
    })

    expect(await withdraw(t, "citizen_a")).toMatchObject({
      ok: true,
      outcome: "kept",
      loa: 2,
    })
    expect((await profileOf(t, "citizen_a"))?.loa).toBe(2)
    expect(await attestationsOf(t, "citizen_a")).toMatchObject([
      { status: "withdrawn" },
    ])
  })

  test("sans attestation active : not_attested, rien d'écrit", async () => {
    const t = makeT()
    await readyCitizen(t)
    expect(await withdraw(t, "citizen_a")).toMatchObject({
      ok: true,
      outcome: "not_attested",
      loa: 1,
    })
    expect(await auditsOf(t, "level_attestation_withdrawn")).toHaveLength(0)
  })

  test("un retrait en dryRun n'écrit rien", async () => {
    const t = makeT()
    await readyCitizen(t)
    await attest(t, "citizen_a")

    expect(await withdraw(t, "citizen_a", { dryRun: true })).toMatchObject({
      ok: true,
      outcome: "withdrawn",
      loa: 1,
      dryRun: true,
    })
    expect((await profileOf(t, "citizen_a"))?.loa).toBe(2)
    expect(await attestationsOf(t, "citizen_a")).toMatchObject([{ status: "active" }])
  })

  test("une nouvelle attestation après un retrait réactive la même ligne", async () => {
    const t = makeT()
    await readyCitizen(t)
    await attest(t, "citizen_a")
    const [before] = await attestationsOf(t, "citizen_a")
    await withdraw(t, "citizen_a")

    expect(await attest(t, "citizen_a")).toMatchObject({ ok: true, outcome: "applied" })

    const rows = await attestationsOf(t, "citizen_a")
    expect(rows).toHaveLength(1)
    expect(rows[0]!._id).toBe(before!._id)
    expect(rows[0]).toMatchObject({ status: "active", raised: true, previousLoa: 1 })
    expect(rows[0]!.withdrawnAt).toBeUndefined()
    expect((await profileOf(t, "citizen_a"))?.loa).toBe(2)
  })

  test("deux partenaires : le premier retrait garde le niveau, le dernier le ramène", async () => {
    // Sans transfert de charge, le compte resterait au Niveau 2 sans aucune
    // attestation active ni pièce examinée.
    const t = makeT()
    await readyCitizen(t)
    await enable(t, OTHER_CLIENT)
    await seedConsent(t, "citizen_a", OTHER_CLIENT)
    await attest(t, "citizen_a")
    expect(await attest(t, "citizen_a", { clientId: OTHER_CLIENT })).toMatchObject({
      outcome: "recorded",
    })

    expect(await withdraw(t, "citizen_a")).toMatchObject({ outcome: "kept", loa: 2 })
    expect(
      await withdraw(t, "citizen_a", { clientId: OTHER_CLIENT }),
    ).toMatchObject({ outcome: "withdrawn", loa: 1 })
    expect((await profileOf(t, "citizen_a"))?.loa).toBe(1)
  })
})

describe("lecture de contrôle", () => {
  test("listAttested pagine les attestations actives", async () => {
    const t = makeT()
    await readyCitizen(t)
    await attest(t, "citizen_a")

    const page = await t.query(internal.partnerLevel.attestations.listAttested, {
      paginationOpts: { numItems: 10, cursor: null },
    })
    expect(page.isDone).toBe(true)
    expect(page.page).toMatchObject([
      { userId: "citizen_a", clientId: CLIENT, kind: KIND, raised: true },
    ])
  })
})
