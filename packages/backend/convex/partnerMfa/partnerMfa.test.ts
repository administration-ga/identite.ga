/// <reference types="vite/client" />
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test"
import { convexTest } from "convex-test"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { api, internal } from "../_generated/api"
import type { Id } from "../_generated/dataModel"
import schema from "../schema"
import { REQUEST_TTL_MS } from "./rules"
import { hotp, timeCounter } from "./totpCore"

const modules = import.meta.glob("/convex/**/*.ts")

const KNOWN_SUBJECTS = vi.hoisted(() => new Set(["citizen_a", "citizen_b"]))

// Le composant Better Auth ne tourne pas sous convex-test : seul son point
// d'entrée utilisé par le module (`getAnyUserById`) est simulé.
vi.mock("../auth", () => ({
  authComponent: {
    getAnyUserById: async (_ctx: unknown, id: string) =>
      KNOWN_SUBJECTS.has(id) ? { _id: id, email: `${id}@idn.ga`, name: id } : null,
  },
}))

vi.mock("../lib/auth", async () => {
  const { ConvexError } = await import("convex/values")
  return {
    requireAuth: async (ctx: {
      auth: { getUserIdentity: () => Promise<{ subject: string } | null> }
    }) => {
      const identity = await ctx.auth.getUserIdentity()
      if (!identity) {
        throw new ConvexError({
          code: "UNAUTHENTICATED",
          message: "Vous devez être connecté.",
        })
      }
      return {
        userId: identity.subject,
        email: `${identity.subject}@idn.ga`,
        emailVerified: true,
        roles: [],
      }
    },
  }
})

const CLIENT = {
  clientId: "diplomate-ga",
  clientName: "Diplomate.ga",
  clientIcon: "https://diplomate.ga/icon.png",
}
const OTHER_CLIENT = {
  clientId: "consulat-ga",
  clientName: "Consulat.ga",
}
const SAVED_KEY = process.env.IDN_AUTHENTICATOR_KEY
const TEST_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"

beforeEach(() => {
  process.env.IDN_AUTHENTICATOR_KEY = TEST_KEY
})

afterEach(() => {
  vi.useRealTimers()
  if (SAVED_KEY === undefined) delete process.env.IDN_AUTHENTICATOR_KEY
  else process.env.IDN_AUTHENTICATOR_KEY = SAVED_KEY
})

function makeT() {
  const t = convexTest(schema, modules)
  registerRateLimiter(t)
  return t
}

type T = ReturnType<typeof makeT>

const citizen = (t: T, subject = "citizen_a") => t.withIdentity({ subject })

async function registerPhone(t: T, subject = "citizen_a", installationId = "install-aaaa-0001") {
  const result = await citizen(t, subject).mutation(api.partnerMfa.devices.registerDevice, {
    installationId,
    name: "iPhone de test",
    platform: "ios",
  })
  return { ...result, secret: result.secret! }
}

function partnerCreate(
  t: T,
  overrides: Partial<{
    clientId: string
    sub: string
    kind: "enroll" | "login" | "sensitive"
    actionLabel: string
  }> = {},
) {
  return t.mutation(internal.partnerMfa.requests.createRequest, {
    clientId: CLIENT.clientId,
    clientName: CLIENT.clientName,
    clientIcon: CLIENT.clientIcon,
    sub: "citizen_a",
    kind: "enroll",
    context: { device: "Chrome sur Mac", location: "Libreville", ip: "196.1.1.1" },
    ...overrides,
  })
}

/**
 * Insère `count` demandes `login` échues mais restées `pending`, comme celles
 * qu'un utilisateur laisse passer sans répondre. Même utilisateur que `like`.
 */
async function insertStalePending(t: T, like: string, count: number) {
  await t.run(async (ctx) => {
    const ref = await ctx.db.get(like as Id<"partnerMfaRequest">)
    if (!ref) throw new Error("demande de référence introuvable")
    const past = Date.now() - REQUEST_TTL_MS * 10
    for (let i = 0; i < count; i++) {
      await ctx.db.insert("partnerMfaRequest", {
        userId: ref.userId,
        clientId: ref.clientId,
        clientName: ref.clientName,
        kind: "login",
        context: {},
        number: "11",
        choices: ["11", "22", "33"],
        status: "pending",
        createdAt: past,
        expiresAt: past + REQUEST_TTL_MS,
      })
    }
  })
}

/** Crée une demande `enroll`, l'approuve dans l'app : le lien existe ensuite. */
async function linkCitizen(t: T, subject = "citizen_a") {
  await registerPhone(t, subject, `install-${subject}-0001`)
  const created = await partnerCreate(t, { sub: subject, kind: "enroll" })
  if (!created.ok) throw new Error(`création refusée : ${created.error}`)
  const decided = await citizen(t, subject).mutation(api.partnerMfa.requests.respond, {
    id: created.requestId,
    choice: created.number,
  })
  expect(decided.status).toBe("approved")
  return created
}

describe("appareils de confiance", () => {
  test("le secret n'est renvoyé qu'à la création, pas au réenregistrement", async () => {
    const t = makeT()
    const first = await registerPhone(t)
    expect(first.created).toBe(true)
    expect(first.secret).toMatch(/^[A-Z2-7]{32}$/)

    const again = await citizen(t).mutation(api.partnerMfa.devices.registerDevice, {
      installationId: "install-aaaa-0001",
      name: "iPhone renommé",
      platform: "ios",
    })
    expect(again).toEqual({ created: false, deviceId: first.deviceId, secret: null })
  })

  test("rotateDevice régénère un secret, différent de l'ancien", async () => {
    const t = makeT()
    const first = await registerPhone(t)
    const rotated = await citizen(t).mutation(api.partnerMfa.devices.rotateDevice, {
      installationId: "install-aaaa-0001",
    })
    expect(rotated.deviceId).toBe(first.deviceId)
    expect(rotated.secret).not.toBe(first.secret)
  })

  test("myDevices n'expose jamais le secret", async () => {
    const t = makeT()
    await registerPhone(t)
    const devices = await citizen(t).query(api.partnerMfa.devices.myDevices, {})
    expect(devices).toHaveLength(1)
    expect(JSON.stringify(devices)).not.toContain("secret")
    expect(Object.keys(devices[0]!)).not.toContain("secret")
  })

  test("un appareil révoqué disparaît et n'est plus utilisé pour les codes", async () => {
    const t = makeT()
    await linkCitizen(t)
    const [only] = await citizen(t).query(api.partnerMfa.devices.myDevices, {})
    await citizen(t).mutation(api.partnerMfa.devices.revokeDevice, { deviceId: only!.deviceId })
    expect(await citizen(t).query(api.partnerMfa.devices.myDevices, {})).toEqual([])
    const verdict = await t.mutation(internal.partnerMfa.totp.verifyCode, {
      clientId: CLIENT.clientId,
      sub: "citizen_a",
      code: "000000",
    })
    expect(verdict).toEqual({ ok: false, error: "no_device" })
  })

  test("refuse un onzième appareil actif", async () => {
    const t = makeT()
    for (let i = 0; i < 10; i++) {
      await registerPhone(t, "citizen_a", `install-number-${i}`)
    }
    await expect(
      citizen(t).mutation(api.partnerMfa.devices.registerDevice, {
        installationId: "install-number-10",
        name: "De trop",
        platform: "android",
      }),
    ).rejects.toThrow(/Au plus 10/)
  })

  test("enregistrer un appareil laisse une trace dans le journal d'audit", async () => {
    const t = makeT()
    await registerPhone(t)
    const rows = await t.run((ctx) => ctx.db.query("auditLog").collect())
    expect(rows.map((row) => row.action)).toContain("partner_mfa_device_registered")
  })
})

describe("demande enroll, puis lien, puis connexion approuvée", () => {
  test("l'app ne voit jamais le nombre, seulement les trois choix", async () => {
    const t = makeT()
    await registerPhone(t)
    const created = await partnerCreate(t, { kind: "enroll" })
    expect(created.ok).toBe(true)

    const pending = await citizen(t).query(api.partnerMfa.requests.myPending, {})
    expect(pending).toHaveLength(1)
    expect(Object.keys(pending[0]!)).not.toContain("number")
    expect(pending[0]!.choices).toHaveLength(3)
    expect(pending[0]!.choices).toContain(created.ok ? created.number : "")
    expect(pending[0]!.clientName).toBe("Diplomate.ga")
    expect(pending[0]!.kind).toBe("enroll")

    const detail = await citizen(t).query(api.partnerMfa.requests.get, {
      id: created.ok ? created.requestId : "",
    })
    expect(Object.keys(detail!)).not.toContain("number")
  })

  test("le bon nombre approuve et crée le lien ; le partenaire le voit", async () => {
    const t = makeT()
    await registerPhone(t)
    const created = await partnerCreate(t, { kind: "enroll" })
    if (!created.ok) throw new Error("création refusée")

    const decided = await citizen(t).mutation(api.partnerMfa.requests.respond, {
      id: created.requestId,
      choice: created.number,
      installationId: "install-aaaa-0001",
    })
    expect(decided).toEqual({ status: "approved" })

    const links = await citizen(t).query(api.partnerMfa.links.myLinks, {})
    expect(links).toEqual([
      expect.objectContaining({ clientId: "diplomate-ga", clientName: "Diplomate.ga" }),
    ])

    const status = await t.query(internal.partnerMfa.links.linkStatus, {
      clientId: CLIENT.clientId,
      sub: "citizen_a",
    })
    expect(status).toEqual({ ok: true, linked: true, devices: 1 })
  })

  test("une connexion approuvée après le lien est visible côté partenaire", async () => {
    const t = makeT()
    await linkCitizen(t)
    const login = await partnerCreate(t, { kind: "login", actionLabel: undefined })
    if (!login.ok) throw new Error(`login refusé : ${login.error}`)

    const decided = await citizen(t).mutation(api.partnerMfa.requests.respond, {
      id: login.requestId,
      choice: login.number,
    })
    expect(decided.status).toBe("approved")

    const status = await t.query(internal.partnerMfa.requests.partnerStatus, {
      clientId: CLIENT.clientId,
      requestId: login.requestId,
    })
    expect(status).toMatchObject({ status: "approved" })
    expect(status?.decidedAt).toBeTypeOf("number")
  })

  test("sensitive : l'action demandée est transmise à l'app", async () => {
    const t = makeT()
    await linkCitizen(t)
    const created = await partnerCreate(t, {
      kind: "sensitive",
      actionLabel: "signer une attestation",
    })
    if (!created.ok) throw new Error("refusé")
    const [pending] = await citizen(t).query(api.partnerMfa.requests.myPending, {})
    expect(pending).toMatchObject({ kind: "sensitive", actionLabel: "signer une attestation" })
  })
})

describe("réponses, refus, expiration, annulation", () => {
  test("un mauvais nombre clôt la demande en wrong_number, même avec le bon choix ensuite", async () => {
    const t = makeT()
    await linkCitizen(t)
    const login = await partnerCreate(t, { kind: "login" })
    if (!login.ok) throw new Error("refusé")
    // Le mauvais choix doit venir des trois choix réellement affichés à l'app.
    const [shown] = await citizen(t).query(api.partnerMfa.requests.myPending, {})
    const wrong = shown!.choices.find((choice) => choice !== login.number)!
    const first = await citizen(t).mutation(api.partnerMfa.requests.respond, {
      id: login.requestId,
      choice: wrong,
    })
    expect(first).toEqual({ status: "wrong_number" })
    const second = await citizen(t).mutation(api.partnerMfa.requests.respond, {
      id: login.requestId,
      choice: login.number,
    })
    expect(second).toEqual({ status: "wrong_number" })
  })

  test("un choix absent de la demande est refusé sans rien changer", async () => {
    const t = makeT()
    await linkCitizen(t)
    const login = await partnerCreate(t, { kind: "login" })
    if (!login.ok) throw new Error("refusé")
    await expect(
      citizen(t).mutation(api.partnerMfa.requests.respond, {
        id: login.requestId,
        choice: "99x",
      }),
    ).rejects.toThrow(/ne fait pas partie/)
    const [still] = await citizen(t).query(api.partnerMfa.requests.myPending, {})
    expect(still).toBeDefined()
  })

  test("un appareil qui n'appartient pas au compte est refusé", async () => {
    const t = makeT()
    await linkCitizen(t)
    const login = await partnerCreate(t, { kind: "login" })
    if (!login.ok) throw new Error("refusé")
    await expect(
      citizen(t).mutation(api.partnerMfa.requests.respond, {
        id: login.requestId,
        choice: login.number,
        installationId: "install-inconnu-9999",
      }),
    ).rejects.toThrow(/pas enregistré/)
  })

  test("refus explicite : « ce n'était pas moi »", async () => {
    const t = makeT()
    await linkCitizen(t)
    const login = await partnerCreate(t, { kind: "login" })
    if (!login.ok) throw new Error("refusé")
    expect(
      await citizen(t).mutation(api.partnerMfa.requests.deny, { id: login.requestId }),
    ).toEqual({ status: "denied" })
    expect(
      await t.query(internal.partnerMfa.requests.partnerStatus, {
        clientId: CLIENT.clientId,
        requestId: login.requestId,
      }),
    ).toMatchObject({ status: "denied" })
  })

  test("une demande échue est expirée à la lecture et ne peut plus être tranchée", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const t = makeT()
    await linkCitizen(t)
    const login = await partnerCreate(t, { kind: "login" })
    if (!login.ok) throw new Error("refusé")

    vi.setSystemTime(Date.now() + REQUEST_TTL_MS + 1)

    expect(await citizen(t).query(api.partnerMfa.requests.myPending, {})).toEqual([])
    expect(
      await t.query(internal.partnerMfa.requests.partnerStatus, {
        clientId: CLIENT.clientId,
        requestId: login.requestId,
      }),
    ).toMatchObject({ status: "expired" })
    expect(
      await citizen(t).mutation(api.partnerMfa.requests.respond, {
        id: login.requestId,
        choice: login.number,
      }),
    ).toEqual({ status: "expired" })
  })

  test("des demandes ignorées par dizaines ne masquent pas la nouvelle demande", async () => {
    // Une demande ignorée reste `pending` en base (seule une réponse tardive la
    // passe à `expired`). Après une vingtaine, l'app ne doit pas les lire à la
    // place de la demande en cours.
    const t = makeT()
    const enroll = await linkCitizen(t)
    await insertStalePending(t, enroll.requestId, 25)
    const login = await partnerCreate(t, { kind: "login" })
    if (!login.ok) throw new Error("refusé")

    const pending = await citizen(t).query(api.partnerMfa.requests.myPending, {})
    expect(pending.map((p) => p.id)).toEqual([login.requestId])
    expect(pending[0].choices).toContain(login.number)
  })

  test("le partenaire peut annuler une demande en attente, puis plus", async () => {
    const t = makeT()
    await linkCitizen(t)
    const login = await partnerCreate(t, { kind: "login" })
    if (!login.ok) throw new Error("refusé")

    expect(
      await t.mutation(internal.partnerMfa.requests.partnerCancel, {
        clientId: CLIENT.clientId,
        requestId: login.requestId,
      }),
    ).toEqual({ ok: true })
    expect(
      await t.mutation(internal.partnerMfa.requests.partnerCancel, {
        clientId: CLIENT.clientId,
        requestId: login.requestId,
      }),
    ).toEqual({ ok: false, error: "request_closed", status: "cancelled" })
    // Une réponse tardive de l'app ne ressuscite pas la demande.
    expect(
      await citizen(t).mutation(api.partnerMfa.requests.respond, {
        id: login.requestId,
        choice: login.number,
      }),
    ).toEqual({ status: "cancelled" })
  })

  test("l'historique liste les demandes tranchées, jamais les demandes en attente", async () => {
    const t = makeT()
    const enroll = await linkCitizen(t)
    const pendingOne = await partnerCreate(t, { kind: "login" })
    const decidedOne = await partnerCreate(t, { kind: "login" })
    if (!pendingOne.ok || !decidedOne.ok) throw new Error("refusé")
    await citizen(t).mutation(api.partnerMfa.requests.deny, { id: decidedOne.requestId })
    const history = await citizen(t).query(api.partnerMfa.requests.myHistory, {})
    const ids = history.map((row) => row.id)
    expect(ids).toContain(decidedOne.requestId)
    expect(ids).toContain(enroll.requestId)
    expect(ids).not.toContain(pendingOne.requestId)
    expect(history.find((row) => row.id === decidedOne.requestId)).toMatchObject({
      status: "denied",
    })
  })
})

describe("cloisonnement entre partenaires et entre utilisateurs", () => {
  test("un partenaire ne lit ni n'annule les demandes d'un autre", async () => {
    const t = makeT()
    await linkCitizen(t)
    const login = await partnerCreate(t, { kind: "login" })
    if (!login.ok) throw new Error("refusé")

    expect(
      await t.query(internal.partnerMfa.requests.partnerStatus, {
        clientId: OTHER_CLIENT.clientId,
        requestId: login.requestId,
      }),
    ).toBeNull()
    expect(
      await t.mutation(internal.partnerMfa.requests.partnerCancel, {
        clientId: OTHER_CLIENT.clientId,
        requestId: login.requestId,
      }),
    ).toEqual({ ok: false, error: "not_found" })
    // La demande reste en attente pour le bon partenaire.
    expect(
      await t.query(internal.partnerMfa.requests.partnerStatus, {
        clientId: CLIENT.clientId,
        requestId: login.requestId,
      }),
    ).toMatchObject({ status: "pending" })
  })

  test("un utilisateur ne voit ni ne tranche les demandes d'un autre", async () => {
    const t = makeT()
    await linkCitizen(t, "citizen_a")
    const login = await partnerCreate(t, { kind: "login", sub: "citizen_a" })
    if (!login.ok) throw new Error("refusé")

    expect(
      await citizen(t, "citizen_b").query(api.partnerMfa.requests.get, {
        id: login.requestId,
      }),
    ).toBeNull()
    await expect(
      citizen(t, "citizen_b").mutation(api.partnerMfa.requests.respond, {
        id: login.requestId,
        choice: login.number,
      }),
    ).rejects.toThrow(/introuvable/)
    await expect(
      citizen(t, "citizen_b").mutation(api.partnerMfa.requests.deny, {
        id: login.requestId,
      }),
    ).rejects.toThrow(/introuvable/)
    expect(await citizen(t, "citizen_b").query(api.partnerMfa.requests.myPending, {})).toEqual([])
  })

  test("un lien ne vaut que pour le partenaire qui l'a obtenu", async () => {
    const t = makeT()
    await linkCitizen(t)
    expect(
      await partnerCreate(t, { clientId: OTHER_CLIENT.clientId, kind: "login" }),
    ).toEqual({ ok: false, error: "not_linked" })
  })
})

describe("garde-fous de création", () => {
  test("login ou sensitive sans lien actif : not_linked", async () => {
    const t = makeT()
    await registerPhone(t)
    expect(await partnerCreate(t, { kind: "login" })).toEqual({
      ok: false,
      error: "not_linked",
    })
    expect(await partnerCreate(t, { kind: "sensitive" })).toEqual({
      ok: false,
      error: "not_linked",
    })
  })

  test("aucun appareil enregistré : no_device, même pour un enroll", async () => {
    const t = makeT()
    expect(await partnerCreate(t, { kind: "enroll" })).toEqual({
      ok: false,
      error: "no_device",
    })
  })

  test("sujet inconnu : unknown_subject, avant toute vérification de lien", async () => {
    const t = makeT()
    expect(await partnerCreate(t, { sub: "ghost", kind: "login" })).toEqual({
      ok: false,
      error: "unknown_subject",
    })
  })

  test("six demandes par minute et par partenaire et citoyen, la septième est limitée", async () => {
    const t = makeT()
    await registerPhone(t)
    for (let i = 0; i < 6; i++) {
      expect((await partnerCreate(t, { kind: "enroll" })).ok).toBe(true)
    }
    expect(await partnerCreate(t, { kind: "enroll" })).toEqual({
      ok: false,
      error: "rate_limited",
    })
    // Le quota est par couple partenaire / citoyen : un autre citoyen passe.
    await registerPhone(t, "citizen_b", "install-bbbb-0001")
    expect((await partnerCreate(t, { sub: "citizen_b", kind: "enroll" })).ok).toBe(true)
  })
})

describe("révocation des liens", () => {
  test("l'utilisateur retire un service : plus de demande possible, demandes en attente annulées", async () => {
    const t = makeT()
    await linkCitizen(t)
    const login = await partnerCreate(t, { kind: "login" })
    if (!login.ok) throw new Error("refusé")

    await citizen(t).mutation(api.partnerMfa.links.revokeLink, { clientId: CLIENT.clientId })

    expect(await citizen(t).query(api.partnerMfa.links.myLinks, {})).toEqual([])
    expect(
      await t.query(internal.partnerMfa.requests.partnerStatus, {
        clientId: CLIENT.clientId,
        requestId: login.requestId,
      }),
    ).toMatchObject({ status: "cancelled" })
    expect(await partnerCreate(t, { kind: "login" })).toEqual({
      ok: false,
      error: "not_linked",
    })
  })

  test("retirer le service annule la demande en cours, même derrière des dizaines de demandes ignorées", async () => {
    const t = makeT()
    const enroll = await linkCitizen(t)
    await insertStalePending(t, enroll.requestId, 60)
    const login = await partnerCreate(t, { kind: "login" })
    if (!login.ok) throw new Error("refusé")

    await citizen(t).mutation(api.partnerMfa.links.revokeLink, { clientId: CLIENT.clientId })

    expect(
      await t.query(internal.partnerMfa.requests.partnerStatus, {
        clientId: CLIENT.clientId,
        requestId: login.requestId,
      }),
    ).toMatchObject({ status: "cancelled" })
  })

  test("le partenaire retire le lien : le statut le reflète, la demande en attente est annulée", async () => {
    const t = makeT()
    await linkCitizen(t)
    const login = await partnerCreate(t, { kind: "login" })
    if (!login.ok) throw new Error("refusé")

    expect(
      await t.mutation(internal.partnerMfa.links.revokeForSubject, {
        clientId: CLIENT.clientId,
        sub: "citizen_a",
      }),
    ).toEqual({ ok: true })
    expect(
      await t.query(internal.partnerMfa.links.linkStatus, {
        clientId: CLIENT.clientId,
        sub: "citizen_a",
      }),
    ).toEqual({ ok: true, linked: false, devices: 1 })
    expect(
      await t.query(internal.partnerMfa.requests.partnerStatus, {
        clientId: CLIENT.clientId,
        requestId: login.requestId,
      }),
    ).toMatchObject({ status: "cancelled" })
    // Le lien d'un autre partenaire n'est pas touché.
    expect(
      await t.mutation(internal.partnerMfa.links.revokeForSubject, {
        clientId: OTHER_CLIENT.clientId,
        sub: "citizen_a",
      }),
    ).toEqual({ ok: true })
  })

  test("un sujet inconnu renvoie unknown_subject", async () => {
    const t = makeT()
    expect(
      await t.mutation(internal.partnerMfa.links.revokeForSubject, {
        clientId: CLIENT.clientId,
        sub: "ghost",
      }),
    ).toEqual({ ok: false, error: "unknown_subject" })
    expect(
      await t.query(internal.partnerMfa.links.linkStatus, {
        clientId: CLIENT.clientId,
        sub: "ghost",
      }),
    ).toEqual({ ok: false, error: "unknown_subject" })
  })
})

describe("vérification des codes TOTP", () => {
  beforeEach(() => {
    // Temps figé : aucun passage de pas pendant le test.
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(1_700_000_000_000)
  })

  async function currentCode(secret: string, offset = 0) {
    return await hotp(secret, timeCounter(Date.now()) + offset)
  }

  test("un code valide passe ; le même code rejoué ne passe plus", async () => {
    const t = makeT()
    const phone = await linkCitizen(t).then(() => registerPhoneSecretOf(t))
    const code = await currentCode(phone)
    const verify = () =>
      t.mutation(internal.partnerMfa.totp.verifyCode, {
        clientId: CLIENT.clientId,
        sub: "citizen_a",
        code,
      })
    expect(await verify()).toEqual({ ok: true, valid: true })
    expect(await verify()).toEqual({ ok: true, valid: false })
  })

  test("accepte le pas précédent, mais pas un pas plus ancien que le dernier accepté", async () => {
    const t = makeT()
    const secret = await linkCitizen(t).then(() => registerPhoneSecretOf(t))
    const previous = await currentCode(secret, -1)
    const current = await currentCode(secret, 0)
    const verify = (code: string) =>
      t.mutation(internal.partnerMfa.totp.verifyCode, {
        clientId: CLIENT.clientId,
        sub: "citizen_a",
        code,
      })
    expect(await verify(previous)).toEqual({ ok: true, valid: true })
    expect(await verify(current)).toEqual({ ok: true, valid: true })
    expect(await verify(previous)).toEqual({ ok: true, valid: false })
  })

  test("un code hors fenêtre et un code faux sont refusés", async () => {
    const t = makeT()
    const secret = await linkCitizen(t).then(() => registerPhoneSecretOf(t))
    const far = await currentCode(secret, 5)
    const wrong = (await currentCode(secret, 0)) === "000000" ? "111111" : "000000"
    const verify = (code: string) =>
      t.mutation(internal.partnerMfa.totp.verifyCode, {
        clientId: CLIENT.clientId,
        sub: "citizen_a",
        code,
      })
    expect(await verify(far)).toEqual({ ok: true, valid: false })
    expect(await verify(wrong)).toEqual({ ok: true, valid: false })
  })

  test("sans lien actif : not_linked ; sujet inconnu : unknown_subject", async () => {
    const t = makeT()
    await registerPhone(t)
    expect(
      await t.mutation(internal.partnerMfa.totp.verifyCode, {
        clientId: CLIENT.clientId,
        sub: "citizen_a",
        code: "123456",
      }),
    ).toEqual({ ok: false, error: "not_linked" })
    expect(
      await t.mutation(internal.partnerMfa.totp.verifyCode, {
        clientId: CLIENT.clientId,
        sub: "ghost",
        code: "123456",
      }),
    ).toEqual({ ok: false, error: "unknown_subject" })
  })

  test("après révocation du lien, le code d'un appareil n'est plus accepté", async () => {
    const t = makeT()
    const secret = await linkCitizen(t).then(() => registerPhoneSecretOf(t))
    const code = await currentCode(secret)
    await citizen(t).mutation(api.partnerMfa.links.revokeLink, { clientId: CLIENT.clientId })
    expect(
      await t.mutation(internal.partnerMfa.totp.verifyCode, {
        clientId: CLIENT.clientId,
        sub: "citizen_a",
        code,
      }),
    ).toEqual({ ok: false, error: "not_linked" })
  })

  test("un appareil révoqué n'authentifie plus : no_device", async () => {
    const t = makeT()
    const secret = await linkCitizen(t).then(() => registerPhoneSecretOf(t))
    const [only] = await citizen(t).query(api.partnerMfa.devices.myDevices, {})
    await citizen(t).mutation(api.partnerMfa.devices.revokeDevice, { deviceId: only!.deviceId })
    const code = await currentCode(secret)
    expect(
      await t.mutation(internal.partnerMfa.totp.verifyCode, {
        clientId: CLIENT.clientId,
        sub: "citizen_a",
        code,
      }),
    ).toEqual({ ok: false, error: "no_device" })
  })

  test("dix vérifications par dix minutes et par partenaire, la onzième est limitée", async () => {
    const t = makeT()
    await linkCitizen(t)
    for (let i = 0; i < 10; i++) {
      expect(
        await t.mutation(internal.partnerMfa.totp.verifyCode, {
          clientId: CLIENT.clientId,
          sub: "citizen_a",
          code: "000000",
        }),
      ).toMatchObject({ ok: true })
    }
    expect(
      await t.mutation(internal.partnerMfa.totp.verifyCode, {
        clientId: CLIENT.clientId,
        sub: "citizen_a",
        code: "000000",
      }),
    ).toEqual({ ok: false, error: "rate_limited" })
  })
})

/**
 * Secret TOTP de l'appareil de test, relu en base : l'API ne le renvoie qu'à la
 * création. On le déchiffre donc comme le ferait le serveur.
 */
async function registerPhoneSecretOf(t: T): Promise<string> {
  const { openDeviceSecret } = await import("./secretBox")
  const device = await t.run((ctx) =>
    ctx.db
      .query("authenticatorDevice")
      .withIndex("by_userId", (q) => q.eq("userId", "citizen_a"))
      .unique(),
  )
  if (!device) throw new Error("appareil absent")
  return await openDeviceSecret(device.secret)
}
