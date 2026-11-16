import { describe, expect, it } from "vitest"

import {
  admitPartnerClient,
  authenticatePartnerClient,
  hashClientSecret,
  parseBasicCredentials,
  parseClientIdList,
  type PartnerClientRow,
} from "./partnerClientAuth"

const SECRET = "s3cret-value-for-tests"

async function confidentialRow(
  overrides: Partial<PartnerClientRow> = {},
): Promise<PartnerClientRow> {
  return {
    clientId: "diplomate-ga",
    clientSecret: await hashClientSecret(SECRET),
    type: "web",
    disabled: false,
    name: "Diplomate.ga",
    icon: "https://diplomate.ga/icon.png",
    ...overrides,
  }
}

function basic(clientId: string, secret: string): string {
  return `Basic ${btoa(`${clientId}:${secret}`)}`
}

describe("parseClientIdList", () => {
  it("renvoie une liste vide sans variable, et tolère espaces et virgules en trop", () => {
    expect(parseClientIdList(undefined)).toEqual([])
    expect(parseClientIdList(" a , b,, ")).toEqual(["a", "b"])
  })
})

describe("hashClientSecret", () => {
  it("produit base64url(SHA-256) sans padding, stable", async () => {
    const hash = await hashClientSecret("abc")
    // SHA-256("abc") = ba7816bf… ; en base64url sans padding : 43 caractères.
    expect(hash).toHaveLength(43)
    expect(hash).not.toMatch(/[+/=]/)
    expect(hash).toBe(await hashClientSecret("abc"))
  })
})

describe("parseBasicCredentials", () => {
  it("lit client_id:client_secret et coupe au premier deux-points", () => {
    expect(parseBasicCredentials(basic("app", "a:b:c"))).toEqual({
      clientId: "app",
      clientSecret: "a:b:c",
    })
  })

  it("refuse un en-tête absent, d'un autre schéma, ou mal encodé", () => {
    expect(parseBasicCredentials(null)).toBeNull()
    expect(parseBasicCredentials("Bearer abc")).toBeNull()
    expect(parseBasicCredentials("Basic %%%")).toBeNull()
    expect(parseBasicCredentials(`Basic ${btoa("sansdeuxpoints")}`)).toBeNull()
    expect(parseBasicCredentials(`Basic ${btoa(":secret")}`)).toBeNull()
    expect(parseBasicCredentials(`Basic ${btoa("app:")}`)).toBeNull()
  })
})

describe("authenticatePartnerClient", () => {
  it("accepte un client confidentiel actif avec le bon secret", async () => {
    expect(await authenticatePartnerClient(await confidentialRow(), SECRET)).toEqual({
      clientId: "diplomate-ga",
      name: "Diplomate.ga",
      icon: "https://diplomate.ga/icon.png",
    })
  })

  it("refuse un mauvais secret", async () => {
    expect(await authenticatePartnerClient(await confidentialRow(), "autre")).toBeNull()
  })

  it("refuse un client absent", async () => {
    expect(await authenticatePartnerClient(null, SECRET)).toBeNull()
  })

  it("refuse un client désactivé, même avec le bon secret", async () => {
    expect(
      await authenticatePartnerClient(await confidentialRow({ disabled: true }), SECRET),
    ).toBeNull()
  })

  it("refuse un client public (sans secret confidentiel)", async () => {
    expect(
      await authenticatePartnerClient(await confidentialRow({ type: "public" }), SECRET),
    ).toBeNull()
  })

  it("refuse un client sans secret enregistré", async () => {
    expect(
      await authenticatePartnerClient(await confidentialRow({ clientSecret: null }), SECRET),
    ).toBeNull()
  })

  it("utilise le client_id comme nom lorsque le nom est vide", async () => {
    const client = await authenticatePartnerClient(
      await confidentialRow({ name: "  " }),
      SECRET,
    )
    expect(client?.name).toBe("diplomate-ga")
  })
})

describe("admitPartnerClient", () => {
  it("admet un client authentifié présent dans la liste blanche", async () => {
    const admission = await admitPartnerClient(await confidentialRow(), SECRET, "x, diplomate-ga")
    expect(admission).toMatchObject({ ok: true, client: { clientId: "diplomate-ga" } })
  })

  it("refuse un client authentifié hors liste blanche (403)", async () => {
    expect(await admitPartnerClient(await confidentialRow(), SECRET, "autre")).toEqual({
      ok: false,
      status: 403,
      error: "client_not_allowed",
    })
  })

  it("refuse tout client quand la liste est absente", async () => {
    expect(await admitPartnerClient(await confidentialRow(), SECRET, undefined)).toMatchObject({
      ok: false,
      status: 403,
    })
  })

  it("répond 401 à un mauvais secret, même si le client n'est pas dans la liste", async () => {
    // Un appelant anonyme ne doit pas apprendre qu'un client est ou non autorisé.
    expect(await admitPartnerClient(await confidentialRow(), "mauvais", "autre")).toEqual({
      ok: false,
      status: 401,
      error: "invalid_client",
    })
  })

  it("répond 401 pour un client désactivé même listé", async () => {
    expect(
      await admitPartnerClient(
        await confidentialRow({ disabled: true }),
        SECRET,
        "diplomate-ga",
      ),
    ).toMatchObject({ ok: false, status: 401 })
  })
})
