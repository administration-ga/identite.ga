import { describe, expect, it, vi } from "vitest"
import { getAppForConsent } from "./oauthAuthorize"

vi.mock("./lib/auth", () => ({
  getCurrentAuthUser: vi.fn(async () => ({ userId: "usager-1", email: "testeur.ae@idn.ga" })),
}))

// L'écran de consentement affiche le plancher que l'émission appliquera :
// pour un client strict, « vérification en cours » n'ouvre pas la porte.
type Consent = { requiredLoA: number; strictLoA: boolean } | null
const run = (metadata: Record<string, unknown>) =>
  (getAppForConsent as unknown as { _handler: (ctx: unknown, args: { clientId: string }) => Promise<Consent> })._handler(
    {
      runQuery: vi.fn().mockResolvedValue({
        page: [{ _id: "a", clientId: "ae_sbx_x", name: "AE", metadata: JSON.stringify(metadata), redirectUrls: "" }],
      }),
    },
    { clientId: "ae_sbx_x" },
  )

describe("getAppForConsent", () => {
  it("annonce un client strict et son plancher", async () => {
    await expect(run({ env: "sandbox", loa: 2, loaEnforcement: "strict", testUsers: ["testeur.ae@idn.ga"] })).resolves.toMatchObject({
      requiredLoA: 2,
      strictLoA: true,
    })
  })

  it("plancher 3 pour un client strict au niveau illisible", async () => {
    await expect(run({ env: "production", loaEnforcement: "strict" })).resolves.toMatchObject({ requiredLoA: 3, strictLoA: true })
  })

  it("un client du portail reste progressif", async () => {
    await expect(run({ env: "production", loa: 2 })).resolves.toMatchObject({ requiredLoA: 2, strictLoA: false })
  })
})
