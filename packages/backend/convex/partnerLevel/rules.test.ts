import { describe, expect, test } from "vitest"

import {
  acrFor,
  changedCivilStatusFields,
  decideAttestation,
  decideWithdrawal,
  isPivotComplete,
  parseAttestBody,
  parseWithdrawBody,
  type AttestationFacts,
  type WithdrawalFacts,
} from "./rules"

/**
 * Règles pures du contrat IDN-ATTESTATION-NIVEAU-V1 (ADR 0003).
 *
 * CE QUI EST EN JEU : un partenaire atteste un fait (inscription consulaire
 * d'un ressortissant), IDN seul décide du niveau. Ces règles disent quand le
 * niveau monte, quand il ne bouge pas, quand IDN refuse, et jusqu'où un
 * retrait peut le faire redescendre. Aucune ne doit jamais faire baisser un
 * niveau acquis par une autre voie.
 */

const ELIGIBLE: AttestationFacts = {
  loa: 1,
  profileType: "citizen",
  pivotComplete: true,
  closing: false,
  latestKycStatus: null,
  openDuplicateFlag: false,
  activeAttestation: null,
  maxLoa: 2,
}

describe("lecture stricte des corps HTTP", () => {
  test("un corps complet est accepté, dryRun vaut faux par défaut", () => {
    expect(
      parseAttestBody({ sub: " user_1 ", kind: "consular_registration" }),
    ).toEqual({
      ok: true,
      value: { sub: "user_1", kind: "consular_registration", dryRun: false },
    })
    expect(
      parseAttestBody({ sub: "user_1", kind: "consular_registration", dryRun: true }),
    ).toEqual({
      ok: true,
      value: { sub: "user_1", kind: "consular_registration", dryRun: true },
    })
  })

  test("un champ en trop est refusé (une faute de frappe ne doit pas passer)", () => {
    const parsed = parseAttestBody({
      sub: "user_1",
      kind: "consular_registration",
      loa: 2,
    })
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.message).toContain("loa")
  })

  test("un type de fait inconnu, un sub vide ou un dryRun non booléen sont refusés", () => {
    expect(parseAttestBody({ sub: "user_1", kind: "passport" }).ok).toBe(false)
    expect(parseAttestBody({ sub: "  ", kind: "consular_registration" }).ok).toBe(false)
    expect(parseAttestBody({ kind: "consular_registration" }).ok).toBe(false)
    expect(
      parseAttestBody({ sub: "u", kind: "consular_registration", dryRun: "oui" }).ok,
    ).toBe(false)
    expect(
      parseAttestBody({ sub: "u".repeat(129), kind: "consular_registration" }).ok,
    ).toBe(false)
    expect(parseAttestBody(null).ok).toBe(false)
    expect(parseAttestBody(["user_1"]).ok).toBe(false)
  })

  test("le retrait suit la même lecture stricte", () => {
    expect(
      parseWithdrawBody({ sub: "user_1", kind: "consular_registration", dryRun: false }),
    ).toEqual({
      ok: true,
      value: { sub: "user_1", kind: "consular_registration", dryRun: false },
    })
    expect(
      parseWithdrawBody({ sub: "user_1", kind: "consular_registration", reason: "x" }).ok,
    ).toBe(false)
  })
})

describe("décision d'attestation", () => {
  test("un citoyen au Niveau 1, profil complet, passe au Niveau 2 (applied)", () => {
    expect(decideAttestation(ELIGIBLE)).toEqual({
      ok: true,
      outcome: "applied",
      loa: 2,
      previousLoa: 1,
      raised: true,
    })
  })

  test("un Niveau 3 n'est jamais abaissé : simple trace (recorded)", () => {
    expect(decideAttestation({ ...ELIGIBLE, loa: 3 })).toEqual({
      ok: true,
      outcome: "recorded",
      loa: 3,
      previousLoa: 3,
      raised: false,
    })
  })

  test("un Niveau 2 acquis par une autre voie est seulement tracé", () => {
    expect(decideAttestation({ ...ELIGIBLE, loa: 2 })).toMatchObject({
      ok: true,
      outcome: "recorded",
      loa: 2,
      raised: false,
    })
  })

  test("une attestation déjà active ne refait rien (already_attested)", () => {
    expect(
      decideAttestation({ ...ELIGIBLE, loa: 2, activeAttestation: { attestedAt: 42 } }),
    ).toEqual({ ok: true, outcome: "already_attested", loa: 2, attestedAt: 42 })
  })

  test("la dernière demande KYC refusée renvoie vers une revue humaine", () => {
    expect(decideAttestation({ ...ELIGIBLE, latestKycStatus: "rejected" })).toEqual({
      ok: false,
      error: "review_required",
      reason: "kyc_rejected",
    })
    // Une demande refusée suivie d'une nouvelle demande n'est plus « la dernière ».
    expect(decideAttestation({ ...ELIGIBLE, latestKycStatus: "submitted" })).toMatchObject({
      ok: true,
      outcome: "applied",
    })
  })

  test("un signalement de doublon ouvert renvoie vers une revue humaine", () => {
    expect(decideAttestation({ ...ELIGIBLE, openDuplicateFlag: true })).toEqual({
      ok: false,
      error: "review_required",
      reason: "duplicate_flag_open",
    })
  })

  test("un visiteur ou un résident n'est pas éligible (profile_type)", () => {
    for (const profileType of ["visitor", "resident", "developer"]) {
      expect(decideAttestation({ ...ELIGIBLE, profileType })).toEqual({
        ok: false,
        error: "not_eligible",
        reason: "profile_type",
      })
    }
  })

  test("un profil incomplet ou un compte en cours de fermeture n'est pas éligible", () => {
    expect(decideAttestation({ ...ELIGIBLE, pivotComplete: false })).toEqual({
      ok: false,
      error: "not_eligible",
      reason: "profile_incomplete",
    })
    expect(decideAttestation({ ...ELIGIBLE, closing: true })).toEqual({
      ok: false,
      error: "not_eligible",
      reason: "account_closing",
    })
  })
})

describe("décision de retrait", () => {
  const RAISED: WithdrawalFacts = {
    attestation: { previousLoa: 1, raised: true },
    loa: 2,
    hasApprovedKyc: false,
    otherActiveAttestations: 0,
  }

  test("un retrait de l'attestation qui avait monté le compte le ramène au niveau d'avant", () => {
    expect(decideWithdrawal(RAISED)).toEqual({ outcome: "withdrawn", loa: 1 })
  })

  test("une demande KYC approuvée garde le niveau (kept)", () => {
    expect(decideWithdrawal({ ...RAISED, hasApprovedKyc: true })).toEqual({
      outcome: "kept",
      loa: 2,
      transferRaise: false,
    })
  })

  test("une attestation qui n'avait rien relevé ne fait rien baisser (kept)", () => {
    expect(
      decideWithdrawal({ ...RAISED, attestation: { previousLoa: 2, raised: false } }),
    ).toEqual({ outcome: "kept", loa: 2, transferRaise: false })
  })

  test("un compte passé au Niveau 3 entre-temps garde son niveau (kept)", () => {
    expect(decideWithdrawal({ ...RAISED, loa: 3 })).toEqual({
      outcome: "kept",
      loa: 3,
      transferRaise: false,
    })
  })

  test("une autre attestation active garde le niveau et en reprend la charge", () => {
    expect(decideWithdrawal({ ...RAISED, otherActiveAttestations: 1 })).toEqual({
      outcome: "kept",
      loa: 2,
      transferRaise: true,
    })
  })

  test("sans attestation active : not_attested, niveau inchangé", () => {
    expect(decideWithdrawal({ ...RAISED, attestation: null })).toEqual({
      outcome: "not_attested",
      loa: 2,
    })
  })
})

describe("niveau publié et état civil verrouillé", () => {
  test("acr suit le niveau", () => {
    expect(acrFor(1)).toBe("eidas1")
    expect(acrFor(2)).toBe("eidas2")
    expect(acrFor(3)).toBe("eidas3")
  })

  test("un pivot complet exige nom, prénom, date ISO et nationalité", () => {
    const pivot = {
      firstName: "Awa",
      lastName: "MBINA",
      dateOfBirth: "1995-03-12",
      nationality: "GA",
    }
    expect(isPivotComplete(pivot)).toBe(true)
    expect(isPivotComplete(undefined)).toBe(false)
    expect(isPivotComplete({ ...pivot, lastName: " " })).toBe(false)
    expect(isPivotComplete({ ...pivot, dateOfBirth: "12/03/1995" })).toBe(false)
    expect(isPivotComplete({ ...pivot, nationality: "" })).toBe(false)
  })

  test("seuls les champs réellement changés comptent, après la même normalisation", () => {
    const current = {
      firstName: "Awa",
      lastName: "MBINA",
      dateOfBirth: "1995-03-12",
      nationality: "GA",
    }
    expect(
      changedCivilStatusFields(current, {
        firstName: " Awa ",
        lastName: "MBINA",
        dateOfBirth: "1995-03-12",
        nationality: " ga",
      }),
    ).toEqual([])
    expect(
      changedCivilStatusFields(current, { ...current, lastName: "MBINA NDONG" }),
    ).toEqual(["lastName"])
    expect(
      changedCivilStatusFields(current, {
        ...current,
        dateOfBirth: "1995-03-13",
        nationality: "FR",
      }),
    ).toEqual(["dateOfBirth", "nationality"])
    expect(changedCivilStatusFields(undefined, current)).toEqual([
      "firstName",
      "lastName",
      "dateOfBirth",
      "nationality",
    ])
  })
})
