import { describe, expect, it, vi } from "vitest"
import { bootstrapTrustedClient, listUnmanagedClients, rotateTrustedClientSecret, setScopes } from "./apps"

vi.mock("../lib/auth", () => ({
  getCurrentAuthUser: vi.fn(),
  requireAuth: vi.fn(),
  requireDeveloper: vi.fn(async () => ({ userId: "dev-proprietaire" })),
}))

// Le composant Better Auth est simulé ; le handler interne et sa validation
// sont ceux de production. Aucune clé de déploiement ni requête réseau.
const invoke = bootstrapTrustedClient as unknown as {
  isInternal: boolean
  _handler: (ctx: { runQuery: ReturnType<typeof vi.fn>; runMutation: ReturnType<typeof vi.fn> },
    args: {
      name: string; redirectUris: string[]; scopes: string[]; loa: 1 | 2
      env?: "sandbox" | "production"; testUsers?: string[]
    }) =>
      Promise<{ id: string; clientId: string; clientSecret: string }>
}
const input = {
  name: "NDJOBI", redirectUris: ["https://ndjobi.app/api/auth/oauth2/callback/idn"],
  scopes: ["openid", "profile", "email"], loa: 1 as const, env: "production" as const,
}
const context = () => ({
  runQuery: vi.fn().mockResolvedValue({ page: [] }),
  runMutation: vi.fn().mockResolvedValue({ _id: "client-test" }),
})

describe("amorçage du client de confiance Ndjobi", () => {
  it("reste interne et persiste uniquement un hash compatible Better Auth", async () => {
    const ctx = context()
    const result = await invoke._handler(ctx, input)
    expect(invoke.isInternal).toBe(true)
    expect(result.clientSecret).toMatch(/^idn_sk_live_/)
    const stored = ctx.runMutation.mock.calls[0][1].input.data
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(result.clientSecret))
    const expectedHash = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
    expect(stored.clientSecret).toBe(expectedHash)
    expect(JSON.stringify(stored)).not.toContain(result.clientSecret)
    expect(stored.redirectUrls).toBe(input.redirectUris[0])
    expect(JSON.parse(stored.metadata).scopes).toEqual(input.scopes)
  })

  it("refuse de recréer un client existant sans en changer le secret", async () => {
    const ctx = context()
    ctx.runQuery.mockResolvedValue({ page: [{ clientId: "existant" }] })
    await expect(invoke._handler(ctx, input)).rejects.toThrow(/existe déjà/)
    expect(ctx.runMutation).not.toHaveBeenCalled()
  })

  it.each([
    "http://ndjobi.app/callback", "https://ndjobi.app/callback#fragment",
    "https://user:password@ndjobi.app/callback", "https://ndjobi.app/callback,https://evil.example",
    "https://ndjobi.app/call back",
  ])("refuse un callback ambigu ou non sécurisé : %s", async (uri) => {
    const ctx = context()
    await expect(invoke._handler(ctx, { ...input, redirectUris: [uri] })).rejects.toThrow()
    expect(ctx.runMutation).not.toHaveBeenCalled()
  })

  it.each([["profile"], ["openid", "admin:all"]])("refuse des scopes non prévus : %s", async (...scopes) => {
    const ctx = context()
    await expect(invoke._handler(ctx, { ...input, scopes })).rejects.toThrow()
    expect(ctx.runQuery).not.toHaveBeenCalled()
  })
})

type Handler<A, R> = { isInternal?: boolean; _handler: (ctx: never, args: A) => Promise<R> }
const call = <A, R>(fn: unknown, ctx: unknown, args: A) => (fn as Handler<A, R>)._handler(ctx as never, args)

const aeDev = {
  name: "ae.ministere.ga (développement)",
  redirectUris: ["http://localhost:3028/api/auth/oauth2/callback/idn"],
  scopes: ["openid", "profile", "email"],
  loa: 2 as const,
  env: "sandbox" as const,
  testUsers: ["Testeur.AE@idn.ga"],
}

describe("client d'État de développement (bac à sable)", () => {
  it("exige l'environnement, sans valeur par défaut", async () => {
    const ctx = context()
    const { env: _env, ...sansEnv } = input
    await expect(invoke._handler(ctx, sansEnv)).rejects.toThrow(/environnement/i)
    expect(ctx.runMutation).not.toHaveBeenCalled()
  })

  it("crée un client bac à sable strict au niveau 2, sur la boucle locale", async () => {
    const ctx = context()
    const result = await invoke._handler(ctx, aeDev)
    expect(result.clientId).toMatch(/^ae-ministere-ga-developpement_sbx_/)
    expect(result.clientSecret).toMatch(/^idn_sk_test_/)
    const stored = ctx.runMutation.mock.calls[0][1].input.data
    expect(stored.redirectUrls).toBe("http://localhost:3028/api/auth/oauth2/callback/idn")
    const meta = JSON.parse(stored.metadata)
    expect(meta).toMatchObject({ env: "sandbox", loa: 2, loaEnforcement: "strict", testUsers: ["testeur.ae@idn.ga"] })
    expect(meta.productionStatus).toBe("none")
  })

  it("exige au moins un usager de test", async () => {
    const ctx = context()
    await expect(invoke._handler(ctx, { ...aeDev, testUsers: [] })).rejects.toThrow(/usager de test/i)
    await expect(invoke._handler(ctx, { ...aeDev, testUsers: ["pas-un-courriel"] })).rejects.toThrow()
    expect(ctx.runMutation).not.toHaveBeenCalled()
  })

  it.each([
    "http://127.0.0.1:3028/api/auth/oauth2/callback/idn",
    "http://[::1]:3028/api/auth/oauth2/callback/idn",
    "https://dev.ae.example/api/auth/oauth2/callback/idn",
  ])("accepte en bac à sable : %s", async (uri) => {
    const ctx = context()
    await expect(invoke._handler(ctx, { ...aeDev, redirectUris: [uri] })).resolves.toBeTruthy()
  })

  it.each(["http://ae.ministere.ga/cb", "http://localhost.evil.example/cb", "ftp://localhost/cb"])(
    "refuse en bac à sable : %s",
    async (uri) => {
      const ctx = context()
      await expect(invoke._handler(ctx, { ...aeDev, redirectUris: [uri] })).rejects.toThrow()
    },
  )

  it.each(["https://localhost/cb", "http://localhost:3028/cb", "https://127.0.0.1/cb"])(
    "refuse un hôte local en production : %s",
    async (uri) => {
      const ctx = context()
      await expect(invoke._handler(ctx, { ...input, redirectUris: [uri] })).rejects.toThrow()
    },
  )

  it("pose aussi le plancher strict sur un client de production", async () => {
    const ctx = context()
    await invoke._handler(ctx, { ...input, loa: 2 })
    const meta = JSON.parse(ctx.runMutation.mock.calls[0][1].input.data.metadata)
    expect(meta).toMatchObject({ env: "production", loaEnforcement: "strict", status: "production" })
  })
})

describe("plancher strict conservé par le portail", () => {
  it("setScopes ne retire pas loaEnforcement", async () => {
    const doc = {
      _id: "doc1",
      clientId: "x_sbx_abc",
      userId: "dev-proprietaire",
      metadata: JSON.stringify({ env: "sandbox", loa: 2, loaEnforcement: "strict", scopes: ["openid"], createdBy: "dev-proprietaire" }),
    }
    const ctx = { runQuery: vi.fn().mockResolvedValue({ page: [doc] }), runMutation: vi.fn().mockResolvedValue(null) }
    await call(setScopes, ctx, { clientId: "x_sbx_abc", scopes: ["openid", "profile"] })
    const update = ctx.runMutation.mock.calls[0][1].input.update
    expect(JSON.parse(update.metadata)).toMatchObject({ loaEnforcement: "strict", loa: 2, scopes: ["openid", "profile"] })
  })
})

describe("secret d'un client d'État", () => {
  it("se renouvelle en interne, rendu une fois, stocké haché", async () => {
    const doc = {
      _id: "doc2",
      clientId: "ndjobi_prd_abcdefgh",
      metadata: JSON.stringify({ env: "production", loa: 1, loaEnforcement: "strict", createdBy: "" }),
    }
    const ctx = { runQuery: vi.fn().mockResolvedValue({ page: [doc] }), runMutation: vi.fn().mockResolvedValue(null) }
    const fn = rotateTrustedClientSecret as unknown as { isInternal: boolean }
    expect(fn.isInternal).toBe(true)
    const { clientSecret } = await call<{ clientId: string }, { clientSecret: string }>(
      rotateTrustedClientSecret, ctx, { clientId: "ndjobi_prd_abcdefgh" },
    )
    expect(clientSecret).toMatch(/^idn_sk_live_/)
    const update = ctx.runMutation.mock.calls[0][1].input.update
    expect(update.clientSecret).not.toContain(clientSecret)
    expect(update.clientSecret).toHaveLength(43)
  })

  it("refuse un client du portail (il a son propriétaire)", async () => {
    const doc = { _id: "doc3", clientId: "app_sbx_x", metadata: JSON.stringify({ env: "sandbox", createdBy: "dev-1" }) }
    const ctx = { runQuery: vi.fn().mockResolvedValue({ page: [doc] }), runMutation: vi.fn() }
    await expect(call(rotateTrustedClientSecret, ctx, { clientId: "app_sbx_x" })).rejects.toThrow(/portail/i)
    expect(ctx.runMutation).not.toHaveBeenCalled()
  })
})

describe("inventaire des clients hors portail", () => {
  it("signale les clients créés hors du portail ou sans propriétaire", async () => {
    const page = [
      { clientId: "demarche_sbx_AbCdEfGh", name: "Démarche", metadata: JSON.stringify({ env: "sandbox", createdBy: "dev-1" }) },
      { clientId: "QwErTyUiOpAsDfGhJkLzXcVbNmQwErTy", name: "Hameçon", metadata: JSON.stringify({ env: "production" }) },
      { clientId: "ndjobi_prd_AbCdEfGh", name: "NDJOBI", metadata: JSON.stringify({ env: "production", loaEnforcement: "strict", createdBy: "" }) },
    ]
    const ctx = { runQuery: vi.fn().mockResolvedValue({ page, isDone: true, continueCursor: "" }) }
    const result = await call<Record<string, never>, Array<{ clientId: string; reasons: string[] }>>(
      listUnmanagedClients, ctx, {},
    )
    expect(result.map((r) => r.clientId)).toEqual(["QwErTyUiOpAsDfGhJkLzXcVbNmQwErTy", "ndjobi_prd_AbCdEfGh"])
    expect(result[0]!.reasons).toEqual(expect.arrayContaining(["client_id_hors_portail", "sans_proprietaire"]))
    expect(result[1]!.reasons).toEqual(["sans_proprietaire"])
  })
})
