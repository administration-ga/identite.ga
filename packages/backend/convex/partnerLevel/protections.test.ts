/// <reference types="vite/client" />
import { register as registerAggregate } from "@convex-dev/aggregate/test"
import { register as registerBetterAuth } from "@convex-dev/better-auth/test"
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test"
import { ConvexError } from "convex/values"
import { convexTest } from "convex-test"
import { beforeEach, describe, expect, test, vi } from "vitest"

import { api, internal } from "../_generated/api"
import type { Id } from "../_generated/dataModel"
import { assessIdentityCollision } from "../lib/duplicateGuard"
import { derivePivotKeys } from "../lib/identity"
import schema from "../schema"

const modules = import.meta.glob("/convex/**/*.ts")

/**
 * Protections autour d'un Niveau 2 attesté par un partenaire (ADR 0003).
 *
 * CE QUI EST EN JEU : un Niveau 2 « attesté seulement » (l'attestation a monté
 * le compte, aucune pièce n'a été examinée par IDN) ne doit pas passer pour une
 * preuve documentaire :
 *   - le Niveau 3 exige alors la piste documentaire, comme depuis le Niveau 1 ;
 *   - un homonyme qui s'inscrit est signalé, pas refusé (sinon une attestation
 *     suffirait à verrouiller un nom contre son vrai porteur) ;
 *   - l'état civil attesté est verrouillé tant que l'attestation est active.
 * Et toutes ces protections sont INERTES pour un compte sans attestation.
 */

vi.mock("../lib/auth", async () => {
  const { ConvexError: CE } = await import("convex/values")
  const authUser = async (ctx: {
    auth: { getUserIdentity: () => Promise<{ subject: string } | null> }
  }) => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) {
      throw new CE({ code: "UNAUTHENTICATED", message: "Connexion requise." })
    }
    return {
      userId: identity.subject,
      // Domaine IDN : `onboarding.completeSignup` exige handle@idn.ga.
      email: `${identity.subject}@idn.ga`,
      emailVerified: true,
      roles: identity.subject.startsWith("controller_") ? ["identity_controller"] : [],
    }
  }
  return {
    requireAuth: authUser,
    requireVerifiedAuth: authUser,
    getCurrentAuthUser: authUser,
    requireController: async (ctx: {
      auth: { getUserIdentity: () => Promise<{ subject: string } | null> }
    }) => {
      const user = await authUser(ctx)
      if (!user.roles.includes("identity_controller")) {
        throw new CE({ code: "FORBIDDEN", message: "Accès refusé." })
      }
      return user
    },
  }
})

// `privacy/deletion.revokeAllSessions` monte tout Better Auth : hors de portée
// de convex-test. Même parade que `admin/accounts.test.ts`.
vi.mock("../auth", async () => {
  const actual = await vi.importActual<typeof import("../auth")>("../auth")
  return {
    ...actual,
    authComponent: {
      ...actual.authComponent,
      getAuth: async () => ({
        auth: { api: { revokeSession: async () => undefined } },
        headers: new Headers(),
      }),
    },
  }
})

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

const PIVOT = {
  firstName: "Awa",
  lastName: "MBINA",
  dateOfBirth: "1995-03-12",
  gender: "F" as const,
  birthPlace: "Port-Gentil",
  nationality: "GA",
}

async function seedProfile(
  t: T,
  userId: string,
  loa: 1 | 2 | 3,
  pivot: Partial<typeof PIVOT> & { nip?: string } = {},
) {
  const now = Date.now()
  const full = { ...PIVOT, ...pivot }
  await t.run(async (ctx) => {
    await ctx.db.insert("userProfile", {
      userId,
      profileType: "citizen",
      loa,
      pivot: full,
      ...derivePivotKeys(full),
      createdAt: now,
      updatedAt: now,
    })
    await ctx.db.insert("notificationPreference", {
      userId,
      email: { security: true, kyc: false, consent: true, comms: true },
      inApp: { security: true, kyc: true, consent: true, comms: true },
      updatedAt: now,
    })
  })
}

async function seedAttestation(
  t: T,
  userId: string,
  opts: { status?: "active" | "withdrawn"; raised?: boolean } = {},
) {
  const now = Date.now()
  await t.run(async (ctx) => {
    await ctx.db.insert("levelAttestation", {
      userId,
      clientId: "consulat-ga",
      kind: "consular_registration",
      status: opts.status ?? "active",
      previousLoa: opts.raised === false ? 2 : 1,
      raised: opts.raised ?? true,
      attestedAt: now,
      ...(opts.status === "withdrawn" ? { withdrawnAt: now } : {}),
      updatedAt: now,
    })
  })
}

/** Compte au Niveau 2 par la seule attestation d'un partenaire. */
async function seedAttestedOnly(
  t: T,
  userId: string,
  pivot: Partial<typeof PIVOT> & { nip?: string } = {},
) {
  await seedProfile(t, userId, 2, pivot)
  await seedAttestation(t, userId)
}

async function seedApprovedKyc(t: T, userId: string) {
  await t.run(async (ctx) => {
    const now = Date.now()
    await ctx.db.insert("kycRequest", {
      userId,
      documentType: "passport",
      documentImages: {},
      status: "approved",
      reviewedAt: now,
      createdAt: now,
      updatedAt: now,
    })
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

async function submitDocuments(t: T, kycRequestId: Id<"kycRequest">) {
  await t.run(async (ctx) => {
    const front = await ctx.storage.store(new Blob(["recto"]))
    const selfie = await ctx.storage.store(new Blob(["selfie"]))
    await ctx.db.patch(kycRequestId, {
      documentImages: { front },
      selfieImage: selfie,
      status: "submitted",
      submittedAt: Date.now(),
      updatedAt: Date.now(),
    })
  })
}

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise
    return null
  } catch (error) {
    if (error instanceof ConvexError) {
      return (error.data as { code?: string }).code ?? "CONVEX_ERROR"
    }
    throw error
  }
}

beforeEach(() => {
  process.env.LIVEKIT_URL = "wss://video.identite.ga"
  process.env.LIVEKIT_API_KEY = "test-api-key"
  process.env.LIVEKIT_API_SECRET = "test-api-secret-at-least-32-characters"
  process.env.LIVEKIT_AUTOSUSPEND_ENABLED = "false"
})

describe("Niveau 3 depuis un Niveau 2 attesté seulement", () => {
  test("la demande de Niveau 3 ouvre la piste documentaire, comme depuis le Niveau 1", async () => {
    const t = makeT()
    await seedAttestedOnly(t, "citizen_att")
    const citizen = t.withIdentity({ subject: "citizen_att" })

    const result = await citizen.mutation(api.verification.request, {
      targetLoa: 3,
      documentType: "cni_gabon",
    })

    expect(result.verificationId).toBeDefined()
    expect(result.kycRequestId).toBeDefined()
    const verification = await t.run(async (ctx) =>
      ctx.db.get(result.verificationId as Id<"level3Verification">),
    )
    expect(verification?.kycRequestId).toBe(result.kycRequestId)
  })

  test("le Niveau 2 reste acquis : le redemander répond « déjà vérifié »", async () => {
    const t = makeT()
    await seedAttestedOnly(t, "citizen_att")
    const citizen = t.withIdentity({ subject: "citizen_att" })
    expect(
      await codeOf(
        citizen.mutation(api.verification.request, {
          targetLoa: 2,
          documentType: "cni_gabon",
        }),
      ),
    ).toBe("ALREADY_VERIFIED")
  })

  test("les créneaux restent fermés tant que les pièces ne sont pas soumises", async () => {
    const t = makeT()
    await seedAttestedOnly(t, "citizen_att")
    await seedProfile(t, "controller_att", 2, { firstName: "Paul", lastName: "OBAME" })
    const citizen = t.withIdentity({ subject: "citizen_att" })
    const controller = t.withIdentity({ subject: "controller_att" })
    await citizen.mutation(api.verification.request, {
      targetLoa: 3,
      documentType: "cni_gabon",
    })
    const startsAt = Date.now() + 48 * 60 * 60 * 1000
    await controller.mutation(api.level3.scheduling.createAvailability, {
      startsAt,
      endsAt: startsAt + 60 * 60 * 1000,
      durationMinutes: 30,
    })

    expect(await citizen.query(api.level3.scheduling.listAvailable, {})).toHaveLength(0)
    const state = await citizen.query(api.verification.getMine, {})
    expect(state.level3?.canBookAppointment).toBe(false)
  })

  test("une décision de Niveau 3 sans pièce examinée est refusée", async () => {
    const t = makeT()
    await seedAttestedOnly(t, "citizen_att")
    await seedProfile(t, "controller_att", 2, { firstName: "Paul", lastName: "OBAME" })
    const controller = t.withIdentity({ subject: "controller_att" })
    const verificationId = await t.run(async (ctx) => {
      const now = Date.now()
      return await ctx.db.insert("level3Verification", {
        userId: "citizen_att",
        status: "waiting_controller",
        roomName: "idn-l3-attestee",
        entryLoa: 2,
        requestedAt: now,
        updatedAt: now,
      })
    })
    await controller.mutation(api.level3.claim, { verificationId })
    await controller.mutation(api.level3.beginInterview, { verificationId })

    expect(
      await codeOf(controller.mutation(api.level3.approve, { verificationId })),
    ).toBe("DOCUMENT_TRACK_REQUIRED")
    expect((await profileOf(t, "citizen_att"))?.loa).toBe(2)
  })

  test("avec ses pièces constatées, le compte attesté atteint le Niveau 3", async () => {
    const t = makeT()
    await seedAttestedOnly(t, "citizen_att")
    await seedProfile(t, "controller_att", 2, { firstName: "Paul", lastName: "OBAME" })
    const citizen = t.withIdentity({ subject: "citizen_att" })
    const controller = t.withIdentity({ subject: "controller_att" })
    const { verificationId, kycRequestId } = await citizen.mutation(
      api.verification.request,
      { targetLoa: 3, documentType: "cni_gabon" },
    )
    await submitDocuments(t, kycRequestId!)
    await controller.mutation(api.level3.claim, { verificationId: verificationId! })
    await controller.mutation(api.level3.beginInterview, {
      verificationId: verificationId!,
    })

    await controller.mutation(api.level3.approve, { verificationId: verificationId! })

    expect((await profileOf(t, "citizen_att"))?.loa).toBe(3)
    const kyc = await t.run(async (ctx) => ctx.db.get(kycRequestId!))
    expect(kyc?.status).toBe("approved")
  })

  test("un Niveau 2 obtenu par KYC garde son raccourci vers le Niveau 3", async () => {
    // Inertie : sans attestation, rien ne change (pas de seconde piste).
    const t = makeT()
    await seedProfile(t, "citizen_kyc", 2)
    await seedApprovedKyc(t, "citizen_kyc")
    const result = await t
      .withIdentity({ subject: "citizen_kyc" })
      .mutation(api.verification.request, { targetLoa: 3 })
    expect(result.verificationId).toBeDefined()
    expect(result.kycRequestId).toBeUndefined()
  })
})

describe("rapprochement d'identité avec un compte attesté", () => {
  test("un homonyme rencontre un compte attesté seulement : signalé, pas refusé", async () => {
    const t = makeT()
    await seedAttestedOnly(t, "porteur_atteste")

    const verdict = await t.run(async (ctx) =>
      assessIdentityCollision(ctx, { pivotKey: derivePivotKeys(PIVOT).pivotKey }),
    )
    expect(verdict.verdict).toBe("flag")
    expect(verdict.matches.map((m) => m.userId)).toEqual(["porteur_atteste"])
  })

  test("un compte dont les pièces ont été approuvées ferme toujours la porte", async () => {
    const t = makeT()
    await seedAttestedOnly(t, "porteur_kyc")
    await seedApprovedKyc(t, "porteur_kyc")
    await seedProfile(t, "porteur_sans_attestation", 2, { firstName: "Paul" })
    await seedApprovedKyc(t, "porteur_sans_attestation")

    const attestedAndKyc = await t.run(async (ctx) =>
      assessIdentityCollision(ctx, { pivotKey: derivePivotKeys(PIVOT).pivotKey }),
    )
    expect(attestedAndKyc.verdict).toBe("refuse")
    const kycOnly = await t.run(async (ctx) =>
      assessIdentityCollision(ctx, {
        pivotKey: derivePivotKeys({ ...PIVOT, firstName: "Paul" }).pivotKey,
      }),
    )
    expect(kycOnly.verdict).toBe("refuse")
  })

  test("se renommer vers l'identité d'un compte attesté seulement passe et ouvre un dossier", async () => {
    const t = makeT()
    await seedAttestedOnly(t, "porteur_atteste")
    await seedProfile(t, "homonyme", 1, { firstName: "Jeanne", lastName: "NZE" })

    await t.withIdentity({ subject: "homonyme" }).mutation(api.profile.updatePivot, {
      ...PIVOT,
    })

    const flags = await t.run(async (ctx) =>
      ctx.db
        .query("duplicateSignal")
        .withIndex("by_userId", (q) => q.eq("userId", "homonyme"))
        .collect(),
    )
    expect(flags).toHaveLength(1)
    expect(flags[0]!.matchedUserId).toBe("porteur_atteste")
  })
})

describe("état civil verrouillé pendant une attestation active", () => {
  test("changer de nom est refusé, avec un message clair", async () => {
    const t = makeT()
    await seedAttestedOnly(t, "citizen_att")
    const citizen = t.withIdentity({ subject: "citizen_att" })

    let thrown: unknown
    try {
      await citizen.mutation(api.profile.updatePivot, { ...PIVOT, lastName: "MBINA NDONG" })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ConvexError)
    const data = (thrown as ConvexError<{ code: string; message: string }>).data
    expect(data.code).toBe("IDENTITY_LOCKED")
    expect(data.message).toContain("inscription consulaire")
    expect((await profileOf(t, "citizen_att"))?.pivot?.lastName).toBe("MBINA")
  })

  test("changer la date de naissance ou la nationalité est refusé", async () => {
    const t = makeT()
    await seedAttestedOnly(t, "citizen_att")
    const citizen = t.withIdentity({ subject: "citizen_att" })
    expect(
      await codeOf(
        citizen.mutation(api.profile.updatePivot, { ...PIVOT, dateOfBirth: "1995-03-13" }),
      ),
    ).toBe("IDENTITY_LOCKED")
    expect(
      await codeOf(citizen.mutation(api.profile.updatePivot, { ...PIVOT, nationality: "FR" })),
    ).toBe("IDENTITY_LOCKED")
  })

  test("enregistrer sans changement est accepté (mêmes rognages, même casse)", async () => {
    const t = makeT()
    await seedAttestedOnly(t, "citizen_att")
    await t.withIdentity({ subject: "citizen_att" }).mutation(api.profile.updatePivot, {
      ...PIVOT,
      firstName: " Awa ",
      nationality: "ga",
    })
    expect((await profileOf(t, "citizen_att"))?.pivot?.firstName).toBe("Awa")
  })

  test("changer seulement le genre ou le lieu de naissance reste permis", async () => {
    const t = makeT()
    await seedAttestedOnly(t, "citizen_att")
    await t.withIdentity({ subject: "citizen_att" }).mutation(api.profile.updatePivot, {
      ...PIVOT,
      gender: "O",
      birthPlace: "Libreville",
    })
    const profile = await profileOf(t, "citizen_att")
    expect(profile?.pivot?.gender).toBe("O")
    expect(profile?.pivot?.birthPlace).toBe("Libreville")
  })

  test("remplacer un NIP est refusé, en ajouter un premier reste permis", async () => {
    const t = makeT()
    await seedAttestedOnly(t, "citizen_nip", { nip: "GA12345678ABCD" })
    await seedAttestedOnly(t, "citizen_sans_nip", { firstName: "Paul" })

    expect(
      await codeOf(
        t
          .withIdentity({ subject: "citizen_nip" })
          .mutation(api.profile.updateNip, { nip: "GA99999999ZZZZ" }),
      ),
    ).toBe("IDENTITY_LOCKED")
    // Ressaisir le même NIP n'est pas un remplacement.
    await t
      .withIdentity({ subject: "citizen_nip" })
      .mutation(api.profile.updateNip, { nip: "GA12345678ABCD" })

    await t
      .withIdentity({ subject: "citizen_sans_nip" })
      .mutation(api.profile.updateNip, { nip: "GA55555555EEEE" })
    expect((await profileOf(t, "citizen_sans_nip"))?.pivot?.nip).toBe("GA55555555EEEE")
  })

  test("la saisie d'état civil de l'inscription ne contourne pas le verrou", async () => {
    const t = makeT()
    await seedAttestedOnly(t, "citizen_att")
    expect(
      await codeOf(
        t.withIdentity({ subject: "citizen_att" }).mutation(api.onboarding.setIdentityPivot, {
          ...PIVOT,
          lastName: "AUTRE",
        }),
      ),
    ).toBe("IDENTITY_LOCKED")
  })

  test("un Niveau 2 obtenu par KYC, sans attestation, se corrige comme avant", async () => {
    const t = makeT()
    await seedProfile(t, "citizen_kyc", 2)
    await seedApprovedKyc(t, "citizen_kyc")
    await t.withIdentity({ subject: "citizen_kyc" }).mutation(api.profile.updatePivot, {
      ...PIVOT,
      lastName: "MBINA NDONG",
    })
    expect((await profileOf(t, "citizen_kyc"))?.pivot?.lastName).toBe("MBINA NDONG")
  })

  test("une attestation retirée ne verrouille plus rien", async () => {
    const t = makeT()
    await seedProfile(t, "citizen_retire", 1)
    await seedAttestation(t, "citizen_retire", { status: "withdrawn" })
    await t.withIdentity({ subject: "citizen_retire" }).mutation(api.profile.updatePivot, {
      ...PIVOT,
      lastName: "MBINA NDONG",
    })
    expect((await profileOf(t, "citizen_retire"))?.pivot?.lastName).toBe("MBINA NDONG")
  })
})

describe("niveau d'entrée et préparation de l'entretien (revue E)", () => {
  test("la demande de Niveau 3 d'un compte attesté seulement enregistre le niveau de preuve", async () => {
    const t = makeT()
    await seedAttestedOnly(t, "citizen_att")
    const { verificationId } = await t
      .withIdentity({ subject: "citizen_att" })
      .mutation(api.verification.request, { targetLoa: 3, documentType: "cni_gabon" })

    const verification = await t.run(async (ctx) => ctx.db.get(verificationId!))
    expect(verification?.entryLoa).toBe(1)
    const audit = await t.run(async (ctx) =>
      (await ctx.db.query("auditLog").collect()).find(
        (row) => row.action === "level3_requested",
      ),
    )
    expect(audit?.metadata).toMatchObject({ entryLoa: 1, heldLoa: 2 })
  })

  test("un Niveau 2 obtenu par KYC garde un niveau d'entrée 2 (inerte)", async () => {
    const t = makeT()
    await seedProfile(t, "citizen_kyc", 2)
    await seedApprovedKyc(t, "citizen_kyc")
    const { verificationId } = await t
      .withIdentity({ subject: "citizen_kyc" })
      .mutation(api.verification.request, { targetLoa: 3 })

    const verification = await t.run(async (ctx) => ctx.db.get(verificationId!))
    expect(verification?.entryLoa).toBe(2)
    const audit = await t.run(async (ctx) =>
      (await ctx.db.query("auditLog").collect()).find(
        (row) => row.action === "level3_requested",
      ),
    )
    expect(audit?.metadata).not.toHaveProperty("heldLoa")
  })

  test("le contrôleur ne peut pas planifier un compte attesté sans pièces soumises", async () => {
    const t = makeT()
    await seedAttestedOnly(t, "citizen_att")
    await seedProfile(t, "controller_att", 2, { firstName: "Paul", lastName: "OBAME" })
    const controller = t.withIdentity({ subject: "controller_att" })
    const { verificationId } = await t
      .withIdentity({ subject: "citizen_att" })
      .mutation(api.verification.request, { targetLoa: 3, documentType: "cni_gabon" })
    const startsAt = Date.now() + 48 * 60 * 60 * 1000
    await controller.mutation(api.level3.scheduling.createAvailability, {
      startsAt,
      endsAt: startsAt + 60 * 60 * 1000,
      durationMinutes: 30,
    })
    const slot = await t.run(async (ctx) => ctx.db.query("level3AppointmentSlot").first())

    const planning = await controller.query(api.controller.agenda.planning, {
      from: Date.now(),
      to: startsAt + 2 * 60 * 60 * 1000,
    })
    expect(
      planning.waiting.find((row) => row.verificationId === verificationId)?.documentsReady,
    ).toBe(false)
    expect(
      await codeOf(
        controller.mutation(api.controller.agenda.assignSlot, {
          verificationId: verificationId!,
          slotId: slot!._id,
        }),
      ),
    ).toBe("DOCUMENTS_REQUIRED")
  })
})

describe("type de compte sous attestation active (revue F)", () => {
  test("quitter le type citoyen est refusé tant que l'attestation est active", async () => {
    const t = makeT()
    await seedAttestedOnly(t, "citizen_att")
    const citizen = t.withIdentity({ subject: "citizen_att" })

    expect(
      await codeOf(citizen.mutation(api.onboarding.selectProfile, { profileType: "visitor" })),
    ).toBe("IDENTITY_LOCKED")
    expect((await profileOf(t, "citizen_att"))?.profileType).toBe("citizen")
    // Reconfirmer le même type reste permis.
    await citizen.mutation(api.onboarding.selectProfile, { profileType: "citizen" })
  })

  test("sans attestation active, le type se change comme avant", async () => {
    const t = makeT()
    await seedProfile(t, "citizen_libre", 2)
    await seedAttestation(t, "citizen_libre", { status: "withdrawn" })
    await t
      .withIdentity({ subject: "citizen_libre" })
      .mutation(api.onboarding.selectProfile, { profileType: "resident" })
    expect((await profileOf(t, "citizen_libre"))?.profileType).toBe("resident")
  })
})

describe("date du dernier changement d'état civil (revue C)", () => {
  test("updatePivot la pose quand un champ verrouillable change, pas sinon", async () => {
    const t = makeT()
    await seedProfile(t, "citizen_c", 1)
    await t.run(async (ctx) => {
      const profile = await ctx.db
        .query("userProfile")
        .withIndex("by_userId", (q) => q.eq("userId", "citizen_c"))
        .unique()
      await ctx.db.patch(profile!._id, { pivotUpdatedAt: 123 })
    })
    const citizen = t.withIdentity({ subject: "citizen_c" })

    // Mêmes valeurs (rognage et casse compris), et genre seul : inchangé.
    await citizen.mutation(api.profile.updatePivot, { ...PIVOT, firstName: " Awa ", nationality: "ga" })
    await citizen.mutation(api.profile.updatePivot, { ...PIVOT, gender: "O" })
    expect((await profileOf(t, "citizen_c"))?.pivotUpdatedAt).toBe(123)

    const before = Date.now()
    await citizen.mutation(api.profile.updatePivot, { ...PIVOT, lastName: "MBINA NDONG" })
    expect((await profileOf(t, "citizen_c"))?.pivotUpdatedAt).toBeGreaterThanOrEqual(before)
  })

  test("setIdentityPivot la pose quand l'état civil change", async () => {
    const t = makeT()
    await seedProfile(t, "citizen_c", 1)
    const before = Date.now()
    await t
      .withIdentity({ subject: "citizen_c" })
      .mutation(api.onboarding.setIdentityPivot, { ...PIVOT, dateOfBirth: "1995-03-13" })
    expect((await profileOf(t, "citizen_c"))?.pivotUpdatedAt).toBeGreaterThanOrEqual(before)
  })

  test("l'inscription et la création déléguée la posent à la création du pivot", async () => {
    const t = makeT()
    const before = Date.now()
    await t.withIdentity({ subject: "awa.mbina" }).mutation(api.onboarding.completeSignup, {
      handle: "awa.mbina",
      pin: "246813",
      profileType: "citizen",
      pivot: { ...PIVOT, firstName: "Ines" },
    })
    expect((await profileOf(t, "awa.mbina"))?.pivotUpdatedAt).toBeGreaterThanOrEqual(before)

    await t.mutation(internal.delegate.mutations.createDelegatedProfile, {
      userId: "delegue_1",
      profileType: "citizen",
      pivot: { ...PIVOT, firstName: "Jeanne", lastName: "NZE" },
      assignedLoa: 1,
      appClientId: "consulat-ga",
      operatorUserId: "operateur_1",
      claimCodeHash: "abc",
      claimCodeExpiresAt: Date.now() + 60_000,
    })
    expect((await profileOf(t, "delegue_1"))?.pivotUpdatedAt).toBeGreaterThanOrEqual(before)
  })
})

describe("effacement du compte", () => {
  test("l'anonymisation purge les attestations du compte", async () => {
    const t = makeT()
    await seedAttestedOnly(t, "citizen_efface")
    await t.mutation(internal.privacy.deletion.anonymizeAccount, {
      userId: "citizen_efface",
    })
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("levelAttestation")
        .withIndex("by_userId", (q) => q.eq("userId", "citizen_efface"))
        .collect(),
    )
    expect(rows).toHaveLength(0)
  })
})
