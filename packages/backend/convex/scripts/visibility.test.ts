import { describe, expect, it } from "vitest"

// Les scripts d'exploitation (création d'un contrôleur, amorçage d'un usager
// de test…) sont lancés par `convex run` avec la clé d'administration. Aucun
// ne doit être appelable par un client : `createControllerUser:run` donnait
// le rôle identity_controller à quiconque l'appelait, gardé seulement par
// CONVEX_DEPLOYMENT, variable que Convex ne pose pas dans les fonctions.
const modules = import.meta.glob("./*.ts", { eager: true }) as Record<string, Record<string, unknown>>

const publicExports = Object.entries(modules)
  .filter(([path]) => !path.endsWith(".test.ts"))
  .flatMap(([path, exports]) =>
    Object.entries(exports)
      .filter(([, value]) => (value as { isPublic?: boolean } | null)?.isPublic === true)
      .map(([name]) => `${path.replace("./", "")}:${name}`),
  )

describe("scripts d'exploitation", () => {
  it("n'exposent aucune fonction publique", () => {
    expect(Object.keys(modules).length).toBeGreaterThan(1)
    expect(publicExports).toEqual([])
  })
})
