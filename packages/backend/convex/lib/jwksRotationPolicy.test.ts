import { describe, expect, it } from "vitest"
import { DAY_MS, isAutoRotationEnabled, planKeyMaintenance } from "./jwksRotationPolicy"

// Horloge injectée : la purge à 7 jours et la rotation à 90 jours se prouvent
// ici, sans attendre.
const T0 = Date.UTC(2026, 10, 24)
const key = (id: string, ageDays: number, now = T0) => ({ id, createdAt: now - ageDays * DAY_MS })

describe("planKeyMaintenance", () => {
  it("crée une clé quand il n'y en a aucune", () => {
    expect(planKeyMaintenance([], T0, { autoRotate: false })).toMatchObject({ rotate: true, prune: [], reason: "no_key" })
  })

  it("ne tourne pas tant que la rotation automatique n'est pas armée", () => {
    expect(planKeyMaintenance([key("a", 200)], T0, { autoRotate: false })).toMatchObject({
      rotate: false,
      reason: "auto_rotation_disabled",
    })
  })

  it("tourne à 90 jours une fois armée, pas avant", () => {
    expect(planKeyMaintenance([key("a", 89)], T0, { autoRotate: true }).rotate).toBe(false)
    expect(planKeyMaintenance([key("a", 90)], T0, { autoRotate: true })).toMatchObject({ rotate: true, reason: "due" })
  })

  it("jamais deux rotations automatiques à moins de 7 jours, mais le geste forcé passe", () => {
    const policy = { rotationIntervalMs: DAY_MS, overlapMs: 7 * DAY_MS, minRotationGapMs: 7 * DAY_MS }
    expect(planKeyMaintenance([key("b", 3), key("a", 50)], T0, { autoRotate: true, policy })).toMatchObject({
      rotate: false,
      reason: "too_soon",
    })
    expect(planKeyMaintenance([key("b", 0)], T0, { autoRotate: false, force: true })).toMatchObject({
      rotate: true,
      reason: "forced",
    })
  })

  it("garde la clé remplacée 7 jours après la création de sa remplaçante, puis la purge", () => {
    expect(planKeyMaintenance([key("b", 6.9), key("a", 100)], T0, { autoRotate: false }).prune).toEqual([])
    expect(planKeyMaintenance([key("b", 7), key("a", 100)], T0, { autoRotate: false }).prune).toEqual(["a"])
  })

  it("ne purge jamais la clé la plus récente, quel que soit son âge", () => {
    expect(planKeyMaintenance([key("a", 400)], T0, { autoRotate: false }).prune).toEqual([])
    const plan = planKeyMaintenance([key("c", 30), key("b", 60), key("a", 90)], T0, { autoRotate: false })
    expect(plan.prune.sort()).toEqual(["a", "b"])
  })

  it("compte le recouvrement depuis la remplaçante immédiate, pas depuis la plus récente", () => {
    // b a remplacé a il y a 8 jours ; c vient de remplacer b : b reste publiée.
    const plan = planKeyMaintenance([key("c", 1), key("b", 8), key("a", 100)], T0, { autoRotate: false })
    expect(plan.prune).toEqual(["a"])
  })
})

describe("isAutoRotationEnabled", () => {
  it.each([["enabled", true], [" Enabled ", true], ["", false], [undefined, false], ["true", false]])(
    "%j → %j",
    (raw, expected) => expect(isAutoRotationEnabled(raw as string | undefined)).toBe(expected),
  )
})
