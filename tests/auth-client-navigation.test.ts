import { afterAll, describe, expect, test } from "bun:test"

/**
 * Un retour OIDC ne vaut qu'une fois : le code et le `state` sont consommés par
 * le premier passage chez l'application partenaire. Incident du 24/11/2026 sur
 * diaspora.ga : la reprise de `/oauth2/authorize` renvoie `{ redirect: true, url }`,
 * le module de redirection par défaut du client Better Auth naviguait aussitôt
 * vers `url`, puis la page de connexion naviguait une seconde fois vers la même
 * adresse. Le premier retour ouvrait la session sans que le navigateur la reçoive,
 * le second était refusé (`state_mismatch`). Le client du portail ne doit donc
 * JAMAIS naviguer de lui-même : chaque écran décide, une fois, où aller.
 */

const portal = "https://identite.example"
const callback = "https://partenaire.example/api/auth/oauth2/callback/idn?code=code-1&state=state-1"

// Faux navigateur : chaque navigation est comptée, quelle que soit sa forme.
const navigations: string[] = []
const location = {
  origin: portal,
  get href() {
    return `${portal}/sign-in`
  },
  set href(url: string) {
    navigations.push(url)
  },
  assign(url: string) {
    navigations.push(url)
  },
  replace(url: string) {
    navigations.push(url)
  },
}
const storage = new Map<string, string>()
const localStorageStub = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
}
const globals = globalThis as Record<string, unknown>
const originalFetch = globalThis.fetch
globals.window = { location, localStorage: localStorageStub }
globals.localStorage = localStorageStub
globalThis.fetch = (async () =>
  new Response(JSON.stringify({ redirect: true, url: callback }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch

afterAll(() => {
  globalThis.fetch = originalFetch
  delete globals.window
  delete globals.localStorage
})

// Importés APRÈS le faux navigateur : le client lit `window.location.origin` au chargement.
const { authClient } = await import("../apps/web/lib/auth-client")
const { authorizeFederatedSignIn } = await import("../apps/web/lib/federated-sign-in")

describe("client Better Auth du portail", () => {
  test("une réponse { redirect, url } ne déclenche aucune navigation du client lui-même", async () => {
    navigations.length = 0
    await authClient.$fetch("/oauth2/authorize?client_id=partenaire", { method: "GET" })
    expect(navigations).toEqual([])
  })

  test("la reprise d'une autorisation rend l'adresse de retour, que la page suit UNE fois", async () => {
    navigations.length = 0
    const params = new URLSearchParams({ client_id: "partenaire", response_type: "code", state: "state-1" })
    const url = await authorizeFederatedSignIn(params, authClient)
    expect(url).toBe(callback)
    // Ce que fait la page de connexion : une seule navigation vers le retour.
    window.location.replace(url)
    expect(navigations).toEqual([callback])
  })
})
