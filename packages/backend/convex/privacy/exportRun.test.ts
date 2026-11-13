/// <reference types="vite/client" />
import { register as registerAggregate } from "@convex-dev/aggregate/test"
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test"
import { convexTest } from "convex-test"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { storageTestState } from "../../test/convexStorage.setup"
import { api, internal } from "../_generated/api"
import type { Id } from "../_generated/dataModel"
import schema from "../schema"

const modules = import.meta.glob("/convex/**/*.ts")

function makeTestClient() {
  const t = convexTest({ schema, modules, transactionLimits: true })
  registerAggregate(t, "kycByStatus")
  registerAggregate(t, "usersByLoa")
  registerAggregate(t, "usersByProfile")
  registerRateLimiter(t)
  return t
}

// La session Better Auth reste la frontière publique en production. Comme
// les autres tests métier, on dérive ici l'utilisateur de l'identité du test.
vi.mock("../lib/auth", async () => {
  const { ConvexError } = await import("convex/values")
  return {
    requireAuth: async (ctx: {
      auth: {
        getUserIdentity: () => Promise<{
          subject: string
          email?: string
        } | null>
      }
    }) => {
      const identity = await ctx.auth.getUserIdentity()
      if (!identity) throw new ConvexError({ code: "UNAUTHENTICATED" })
      return {
        userId: identity.subject,
        email: identity.email ?? `${identity.subject}@idn.ga`,
      }
    },
  }
})

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

type TestClient = ReturnType<typeof makeTestClient>
const owner = { userId: "user_export", email: "user_export@idn.ga" }
const ttl = 24 * 60 * 60 * 1000

async function createRequest(t: TestClient, user = owner) {
  const { requestId } = await t.mutation(
    internal.privacy.exportRun.ensureExportRequest,
    user,
  )
  return { ...user, requestId }
}

function jsonBytes(text = "archive") {
  return new TextEncoder().encode(JSON.stringify({ data: text })).buffer
}

async function snapshot(t: TestClient) {
  return await t.run(async (ctx) => ({
    files: await ctx.db.system.query("_storage").collect(),
    jobs: await ctx.db.system.query("_scheduled_functions").collect(),
    audit: await ctx.db.query("auditLog").collect(),
  }))
}

async function storeArchive(t: TestClient, blob: Blob) {
  return await t.action(async (ctx) => await ctx.storage.store(blob))
}

async function reserveArchive(
  t: TestClient,
  request: { userId: string; email: string; requestId: Id<"auditLog"> },
  blob: Blob,
) {
  const sha256 = btoa(
    String.fromCharCode(
      ...new Uint8Array(
        await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
      ),
    ),
  )
  await t.mutation(internal.privacy.exportRun.prepareLargeExport, {
    ...request,
    sha256,
    size: blob.size,
  })
}

describe("privacy.exportRun.collectExportPayload", () => {
  test("l'archive contient le profil mais jamais l'empreinte du PIN", async () => {
    // L'archive part par un lien de stockage non authentifié (e-mail) : une
    // empreinte de PIN à 6 chiffres y serait cassée hors ligne en quelques
    // heures. Le citoyen doit retrouver ses données, pas ce secret.
    const t = makeTestClient()
    const now = Date.now()
    await t.run((ctx) =>
      ctx.db.insert("userProfile", {
        userId: "user_export",
        profileType: "citizen",
        loa: 1,
        phoneKey: null,
        pinHash: "pbkdf2$600000$secret",
        pivot: {
          firstName: "Clarisse",
          lastName: "Nzeng",
          dateOfBirth: "1991-03-04",
          gender: "F",
          birthPlace: "Oyem",
          nationality: "GA",
        },
        createdAt: now,
        updatedAt: now,
      }),
    )

    const payload = await t.query(
      internal.privacy.exportRun.collectExportPayload,
      { userId: "user_export" },
    )

    expect(payload.profile?.pivot?.firstName).toBe("Clarisse")
    expect(payload.profile).not.toHaveProperty("pinHash")
    expect(JSON.stringify(payload)).not.toContain("pbkdf2$600000$secret")
  })

  test("sans profil, l'archive porte un profil nul", async () => {
    const t = makeTestClient()
    const payload = await t.query(
      internal.privacy.exportRun.collectExportPayload,
      { userId: "inconnu" },
    )
    expect(payload.profile).toBeNull()
  })

  test("conserve le périmètre utilisateur et la limite historique de 500 notifications", async () => {
    const t = makeTestClient()
    await t.run(async (ctx) => {
      for (let index = 0; index < 501; index++) {
        await ctx.db.insert("notification", {
          userId: owner.userId,
          channel: "in_app",
          category: "system",
          title: String(index),
          body: "notification",
          createdAt: index,
        })
      }
      await ctx.db.insert("notification", {
        userId: "other_user",
        channel: "in_app",
        category: "system",
        title: "confidentiel",
        body: "ne pas exporter",
        createdAt: 0,
      })
    })
    const payload = await t.query(
      internal.privacy.exportRun.collectExportPayload,
      { userId: owner.userId },
    )
    expect(payload.notifications).toHaveLength(500)
    expect(
      payload.notifications.every(
        (notification) => notification.userId === owner.userId,
      ),
    ).toBe(true)
    expect(payload.notifications[499]?.title).toBe("499")
  })
})

describe("privacy.exportRun — finalisation transactionnelle", () => {
  test("l'action publie un JSON sans PIN, avec trace, email asynchrone et purge à 24 h", async () => {
    const t = makeTestClient()
    await t.run((ctx) =>
      ctx.db.insert("userProfile", {
        userId: owner.userId,
        profileType: "citizen",
        loa: 1,
        pinHash: "secret_pin",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    )
    const request = await createRequest(t)
    await t.action(internal.privacy.exportRun.runDataExport, request)

    const state = await snapshot(t)
    expect(storageTestState.stores).toBe(1)
    expect(state.files).toHaveLength(1)
    expect(state.files[0]?.contentType).toBe("application/json")
    expect(state.jobs).toHaveLength(2)
    const email = state.jobs.find((job) => job.name.includes("sendGeneric"))
    const purge = state.jobs.find((job) => job.name.includes("purgeExportBlob"))
    if (!email || !purge) throw new Error("planifications absentes")
    expect(email?.args).toMatchObject([
      { to: owner.email, subject: "Votre archive de données IDN" },
    ])
    expect(purge.scheduledTime - email.scheduledTime).toBe(ttl)
    expect(
      state.audit.filter(
        (entry) => entry.metadata?.kind === "data_export_ready",
      ),
    ).toMatchObject([
      {
        actorId: owner.userId,
        metadata: {
          storageId: state.files[0]?._id,
          requestId: request.requestId,
          expiresAt: purge.scheduledTime,
        },
      },
    ])
    const archive = await t.action(async (ctx) => {
      const file = state.files[0]
      if (!file) throw new Error("archive absente")
      return await (await ctx.storage.get(file._id))?.text()
    })
    expect(archive).toContain(owner.userId)
    expect(archive).not.toContain("pinHash")
    expect(archive).not.toContain("secret_pin")
    expect(JSON.parse(archive ?? "null")).toMatchObject({
      data: { profile: { userId: owner.userId } },
    })
  })

  test("une URL indisponible annule le petit blob, la trace, l'email et la purge puis permet la reprise", async () => {
    const t = makeTestClient()
    const request = await createRequest(t)
    const before = await snapshot(t)
    storageTestState.urlUnavailable = true
    await expect(
      t.mutation(internal.privacy.exportRun.finalizeExport, {
        ...request,
        bytes: jsonBytes(),
      }),
    ).rejects.toThrow("EXPORT_URL_UNAVAILABLE")
    expect(storageTestState.stores).toBe(1)
    expect(storageTestState.schedules).toBe(0)
    expect(await snapshot(t)).toEqual(before)

    storageTestState.urlUnavailable = false
    const result = await t.mutation(internal.privacy.exportRun.finalizeExport, {
      ...request,
      bytes: jsonBytes(),
    })
    if (result.status !== "ready") throw new Error("archive non publiée")
    const url = await t.query((ctx) => ctx.storage.getUrl(result.storageId))
    if (!url) throw new Error("URL absente")
    const state = await snapshot(t)
    expect(state.files).toHaveLength(1)
    expect(state.jobs).toHaveLength(2)
    expect(
      state.jobs.find((job) => job.name.includes("sendGeneric")),
    ).toMatchObject({
      args: [{ to: owner.email, body: expect.stringContaining(url) }],
    })
    expect(state.audit.map((entry) => entry.metadata?.kind)).toEqual([
      "data_export_requested",
      "data_export_ready",
    ])
  })

  test("une reprise concurrente ne double ni blob, ni email, ni TTL, même après purge", async () => {
    const t = makeTestClient()
    const request = await createRequest(t)
    const [first, second] = await Promise.all([
      t.mutation(internal.privacy.exportRun.finalizeExport, {
        ...request,
        bytes: jsonBytes(),
      }),
      t.mutation(internal.privacy.exportRun.finalizeExport, {
        ...request,
        bytes: jsonBytes(),
      }),
    ])
    expect(first).toEqual(second)
    expect(storageTestState.stores).toBe(1)
    const before = await snapshot(t)
    expect(before.files).toHaveLength(1)
    expect(before.jobs).toHaveLength(2)
    const file = before.files[0]
    if (!file) throw new Error("archive absente")
    await t.mutation(internal.privacy.exportRun.purgeExportBlob, {
      storageId: file._id,
    })
    await t.mutation(internal.privacy.exportRun.purgeExportBlob, {
      storageId: file._id,
    })
    await t.action(internal.privacy.exportRun.runDataExport, request)
    const after = await snapshot(t)
    expect(after.files).toHaveLength(0)
    expect(after.jobs).toEqual(before.jobs)
    expect(after.audit).toEqual(before.audit)
  })

  test.each(["userId", "email"])(
    "refuse une demande liée à un autre %s avant tout stockage",
    async (field) => {
      const t = makeTestClient()
      const request = await createRequest(t)
      await expect(
        t.mutation(internal.privacy.exportRun.finalizeExport, {
          ...request,
          [field]: "intrus",
          bytes: jsonBytes(),
        }),
      ).rejects.toThrow("INVALID_EXPORT_REQUEST")
      const state = await snapshot(t)
      expect(state.files).toHaveLength(0)
      expect(state.jobs).toHaveLength(0)
      expect(storageTestState.stores).toBe(0)
    },
  )

  test("refuse les arguments binaires surdimensionnés", async () => {
    const t = makeTestClient()
    const request = await createRequest(t)
    await expect(
      t.mutation(internal.privacy.exportRun.finalizeExport, {
        ...request,
        bytes: new ArrayBuffer(512 * 1024 + 1),
      }),
    ).rejects.toThrow("EXPORT_TOO_LARGE")
    expect(storageTestState.stores).toBe(0)
    expect((await snapshot(t)).files).toHaveLength(0)
  })

  test.each(["files", "bytes"])(
    "bascule vers l'action quand le budget %s est épuisé",
    async (budget) => {
      const t = makeTestClient()
      const request = await createRequest(t)
      if (budget === "files") storageTestState.filesRemaining = 0
      else storageTestState.bytesRemaining = 0
      await expect(
        t.mutation(internal.privacy.exportRun.finalizeExport, {
          ...request,
          bytes: jsonBytes(),
        }),
      ).resolves.toEqual({ status: "needs_action" })
      expect((await snapshot(t)).files).toHaveLength(0)
      await t.action(internal.privacy.exportRun.runDataExport, request)
      expect(storageTestState.stores).toBe(0)
      const state = await snapshot(t)
      expect(state.files).toHaveLength(1)
      expect(
        state.audit.some(
          (entry) => entry.metadata?.kind === "data_export_prepared",
        ),
      ).toBe(true)
      expect(
        state.audit.some(
          (entry) => entry.metadata?.kind === "data_export_ready",
        ),
      ).toBe(true)
    },
  )

  test.each(["storage", "scheduler"])(
    "annule fichiers, trace et planifications sur erreur %s",
    async (failure) => {
      const t = makeTestClient()
      const request = await createRequest(t)
      if (failure === "storage") storageTestState.failStore = true
      // Le blob et la purge existent déjà quand la planification email échoue.
      else storageTestState.failScheduleAt = 2
      await expect(
        t.mutation(internal.privacy.exportRun.finalizeExport, {
          ...request,
          bytes: jsonBytes(),
        }),
      ).rejects.toThrow(`injected ${failure} failure`)
      const state = await snapshot(t)
      expect(state.files).toHaveLength(0)
      expect(state.jobs).toHaveLength(0)
      expect(state.audit).toHaveLength(1)
      storageTestState.failStore = false
      storageTestState.failScheduleAt = 0
      await expect(
        t.mutation(internal.privacy.exportRun.finalizeExport, {
          ...request,
          bytes: jsonBytes(),
        }),
      ).resolves.toMatchObject({ status: "ready" })
    },
  )
})

describe("privacy.exportRun — archives volumineuses", () => {
  test("une URL indisponible bloque l'adoption sans perdre la réservation ni la purge de secours", async () => {
    const t = makeTestClient()
    await t.run((ctx) =>
      ctx.db.insert("notification", {
        userId: owner.userId,
        channel: "in_app",
        category: "system",
        title: "archive volumineuse",
        body: "x".repeat(600 * 1024),
        createdAt: Date.now(),
      }),
    )
    const request = await createRequest(t)
    storageTestState.urlUnavailable = true
    await expect(
      t.action(internal.privacy.exportRun.runDataExport, request),
    ).rejects.toThrow("EXPORT_URL_UNAVAILABLE")
    const pending = await snapshot(t)
    expect(storageTestState.stores).toBe(0)
    expect(pending.files).toHaveLength(1)
    expect(pending.jobs).toHaveLength(1)
    expect(pending.audit.map((entry) => entry.metadata?.kind)).toEqual([
      "data_export_requested",
      "data_export_prepared",
    ])
    const file = pending.files[0]
    const backupPurge = pending.jobs[0]
    if (!file || !backupPurge) throw new Error("archive ou purge absente")
    expect(file.size).toBeGreaterThan(512 * 1024)
    expect(backupPurge.name).toContain("purgeExportBlob")
    expect(backupPurge.args).toEqual([{ storageId: file._id }])

    storageTestState.urlUnavailable = false
    vi.setSystemTime(Date.now() + 1000)
    await expect(
      t.mutation(internal.privacy.exportRun.finalizeStoredExport, {
        ...request,
        storageId: file._id,
      }),
    ).resolves.toBe(file._id)
    const url = await t.query((ctx) => ctx.storage.getUrl(file._id))
    if (!url) throw new Error("URL absente")
    const ready = await snapshot(t)
    expect(ready.files).toEqual(pending.files)
    expect(ready.audit.slice(0, 2)).toEqual(pending.audit)
    expect(ready.audit[2]?.metadata).toMatchObject({
      kind: "data_export_ready",
      requestId: request.requestId,
      storageId: file._id,
      expiresAt: file._creationTime + ttl,
    })
    expect(ready.jobs).toHaveLength(3)
    expect(ready.jobs).toContainEqual(backupPurge)
    expect(
      ready.jobs.filter((job) => job.name.includes("purgeExportBlob")),
    ).toMatchObject([
      { scheduledTime: backupPurge.scheduledTime },
      { scheduledTime: file._creationTime + ttl },
    ])
    expect(
      ready.jobs.find((job) => job.name.includes("sendGeneric")),
    ).toMatchObject({
      args: [{ to: owner.email, body: expect.stringContaining(url) }],
    })
    await t.mutation(internal.privacy.exportRun.finalizeStoredExport, {
      ...request,
      storageId: file._id,
    })
    expect(await snapshot(t)).toEqual(ready)
  })

  test("supprime son blob si la purge de secours ne peut pas être planifiée", async () => {
    const t = makeTestClient()
    const request = await createRequest(t)
    storageTestState.filesRemaining = 0
    storageTestState.failScheduleAt = 1
    await expect(
      t.action(internal.privacy.exportRun.runDataExport, request),
    ).rejects.toThrow("injected scheduler failure")
    const state = await snapshot(t)
    expect(state.files).toHaveLength(0)
    expect(state.jobs).toHaveLength(0)
    expect(
      state.audit.some((entry) => entry.metadata?.kind === "data_export_ready"),
    ).toBe(false)
  })

  test("ne publie pas une source dont les 24 heures de conservation sont écoulées", async () => {
    const t = makeTestClient()
    const request = await createRequest(t)
    const blob = new Blob(["archive_attendue"], { type: "application/json" })
    await reserveArchive(t, request, blob)
    const storageId = await storeArchive(t, blob)
    vi.setSystemTime(Date.now() + ttl + 1000)
    await expect(
      t.mutation(internal.privacy.exportRun.finalizeStoredExport, {
        ...request,
        storageId,
      }),
    ).rejects.toThrow("EXPORT_SOURCE_EXPIRED")
    expect((await snapshot(t)).jobs).toHaveLength(0)
  })

  test("conserve les archives de plus de 512 Kio dans l'action sans lire le blob en mutation", async () => {
    const t = makeTestClient()
    const body = "x".repeat(600 * 1024)
    await t.run((ctx) =>
      ctx.db.insert("notification", {
        userId: owner.userId,
        channel: "in_app",
        category: "system",
        title: "archive volumineuse",
        body,
        createdAt: Date.now(),
      }),
    )
    const request = await createRequest(t)
    await t.action(internal.privacy.exportRun.runDataExport, request)
    const state = await snapshot(t)
    expect(storageTestState.stores).toBe(0)
    expect(state.files).toHaveLength(1)
    expect(state.files[0]?.size).toBeGreaterThan(512 * 1024)
    const file = state.files[0]
    if (!file) throw new Error("archive absente")
    const json = await t.action(
      async (ctx) => await (await ctx.storage.get(file._id))?.text(),
    )
    expect(json).toContain(body)
    expect(state.audit.map((entry) => entry.metadata?.kind)).toEqual([
      "data_export_requested",
      "data_export_prepared",
      "data_export_ready",
    ])
    expect(
      state.jobs.filter((job) => job.name.includes("sendGeneric")),
    ).toHaveLength(1)
    expect(
      state.jobs.filter((job) => job.name.includes("purgeExportBlob")),
    ).toHaveLength(2)
  })

  test("refuse un storageId sans réservation, puis un fichier différent de la source réservée", async () => {
    const t = makeTestClient()
    const request = await createRequest(t)
    const storageId = await storeArchive(
      t,
      new Blob(["donnees_autre_utilisateur"], { type: "application/json" }),
    )
    await expect(
      t.mutation(internal.privacy.exportRun.finalizeStoredExport, {
        ...request,
        storageId,
      }),
    ).rejects.toThrow("INVALID_EXPORT_SOURCE")
    await reserveArchive(
      t,
      request,
      new Blob(["archive_attendue"], { type: "application/json" }),
    )
    await expect(
      t.mutation(internal.privacy.exportRun.finalizeStoredExport, {
        ...request,
        storageId,
      }),
    ).rejects.toThrow("INVALID_EXPORT_SOURCE")
    const state = await snapshot(t)
    expect(state.jobs).toHaveLength(0)
    expect(
      state.audit.some((entry) => entry.metadata?.kind === "data_export_ready"),
    ).toBe(false)
  })

  test("refuse une source modifiée après réservation et une petite finalisation qui la contournerait", async () => {
    const t = makeTestClient()
    const request = await createRequest(t)
    await reserveArchive(
      t,
      request,
      new Blob(["premiere_source"], { type: "application/json" }),
    )
    await expect(
      reserveArchive(
        t,
        request,
        new Blob(["nouvelle_source"], { type: "application/json" }),
      ),
    ).rejects.toThrow("EXPORT_SOURCE_CHANGED")
    await expect(
      t.mutation(internal.privacy.exportRun.finalizeExport, {
        ...request,
        bytes: jsonBytes(),
      }),
    ).rejects.toThrow("EXPORT_SOURCE_CHANGED")
  })

  test("l'adoption est idempotente et une suppression du fichier avant adoption reste un refus", async () => {
    const t = makeTestClient()
    const request = await createRequest(t)
    const blob = new Blob(["archive_attendue"], { type: "application/json" })
    await reserveArchive(t, request, blob)
    const deleted = await storeArchive(t, blob)
    await t.mutation(internal.privacy.exportRun.purgeExportBlob, {
      storageId: deleted,
    })
    await expect(
      t.mutation(internal.privacy.exportRun.finalizeStoredExport, {
        ...request,
        storageId: deleted,
      }),
    ).rejects.toThrow("INVALID_EXPORT_SOURCE")
    const storageId = await storeArchive(t, blob)
    await expect(
      t.mutation(internal.privacy.exportRun.finalizeStoredExport, {
        ...request,
        storageId,
      }),
    ).resolves.toBe(storageId)
    const before = await snapshot(t)
    await expect(
      t.mutation(internal.privacy.exportRun.finalizeStoredExport, {
        ...request,
        storageId,
      }),
    ).resolves.toBe(storageId)
    expect(await snapshot(t)).toEqual(before)
  })
})

describe("privacy.requestDataExport", () => {
  test("exige une session et conserve la limite d'un export par 24 h", async () => {
    const t = makeTestClient()
    await expect(t.mutation(api.privacy.requestDataExport, {})).rejects.toThrow(
      "UNAUTHENTICATED",
    )
    const authenticated = t.withIdentity({
      subject: owner.userId,
      email: owner.email,
    })
    await authenticated.mutation(api.privacy.requestDataExport, {})
    await expect(
      authenticated.mutation(api.privacy.requestDataExport, {}),
    ).rejects.toThrow()
    const state = await snapshot(t)
    expect(state.audit).toHaveLength(1)
    expect(state.jobs).toHaveLength(1)
    expect(state.jobs[0]?.args).toMatchObject([
      { ...owner, requestId: state.audit[0]?._id },
    ])
  })
})
