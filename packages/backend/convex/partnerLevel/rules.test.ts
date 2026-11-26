import { describe, expect, test } from "vitest"

import {
  acrFor,
  changedCivilStatusFields,
  decideAttestation,
  decideWithdrawal,
  isGaboneseNationality,
  isPivotComplete,
  lastTerminalKycDecision,
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
  kind: "consular_registration",
  loa: 1,
  profileType: "citizen",
  pivotComplete: true,
  nationality: "GA",
  closing: false,
  lastTerminalKyc: null,
  openDuplicateFlag: false,
  pivotUpdatedAt: null,
  identityReadAt: 1_000,
  activeAttestation: null,
  maxLoa: 2,
}

const BODY = { sub: "user_1", kind: "consular_registration", identityReadAt: 0 }

describe("lecture stricte des corps HTTP", () => {
  test("un corps complet est accepté, dryRun vaut faux par défaut", () => {
    expect(
      parseAttestBody({
        sub: " user_1 ",
        kind: "consular_registration",
        identityReadAt: 1_764_072_000_000,
      }),
    ).toEqual({
      ok: true,
      value: {
        sub: "user_1",
        kind: "consular_registration",
        dryRun: false,
        identityReadAt: 1_764_072_000_000,
      },
    })
    expect(parseAttestBody({ ...BODY, dryRun: true })).toEqual({
      ok: true,
      value: {
        sub: "user_1",
        kind: "consular_registration",
        dryRun: true,
        identityReadAt: 0,
      },
    })
  })

  test("un champ en trop est refusé (une faute de frappe ne doit pas passer)", () => {
    const parsed = parseAttestBody({ ...BODY, loa: 2 })
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.message).toContain("loa")
  })

  test("un type de fait inconnu, un sub vide ou un dryRun non booléen sont refusés", () => {
    expect(parseAttestBody({ ...BODY, kind: "passport" }).ok).toBe(false)
    expect(parseAttestBody({ ...BODY, sub: "  " }).ok).toBe(false)
    expect(parseAttestBody({ kind: "consular_registration", identityReadAt: 0 }).ok).toBe(
      false,
    )
    expect(parseAttestBody({ ...BODY, dryRun: "oui" }).ok).toBe(false)
    expect(parseAttestBody({ ...BODY, sub: "u".repeat(129) }).ok).toBe(false)
    expect(parseAttestBody(null).ok).toBe(false)
    expect(parseAttestBody(["user_1"]).ok).toBe(false)
  })

  test("identityReadAt est obligatoire : entier positif ou nul, en millisecondes", () => {
    expect(parseAttestBody({ sub: "user_1", kind: "consular_registration" }).ok).toBe(false)
    expect(parseAttestBody({ ...BODY, identityReadAt: -1 }).ok).toBe(false)
    expect(parseAttestBody({ ...BODY, identityReadAt: 1.5 }).ok).toBe(false)
    expect(parseAttestBody({ ...BODY, identityReadAt: "1764072000000" }).ok).toBe(false)
    expect(parseAttestBody({ ...BODY, identityReadAt: null }).ok).toBe(false)
    expect(parseAttestBody({ ...BODY, identityReadAt: Number.MAX_VALUE }).ok).toBe(false)
    expect(parseAttestBody({ ...BODY, identityReadAt: 0 }).ok).toBe(true)
  })

  test("le retrait suit la même lecture stricte, sans identityReadAt", () => {
    expect(
      parseWithdrawBody({ sub: "user_1", kind: "consular_registration", dryRun: false }),
    ).toEqual({
      ok: true,
      value: { sub: "user_1", kind: "consular_registration", dryRun: false },
    })
    expect(
      parseWithdrawBody({ sub: "user_1", kind: "consular_registration", reason: "x" }).ok,
    ).toBe(false)
    const withReadAt = parseWithdrawBody(BODY)
    expect(withReadAt.ok).toBe(false)
    if (!withReadAt.ok) expect(withReadAt.message).toContain("identityReadAt")
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

  test("la dernière décision KYC est un refus : revue humaine", () => {
    expect(decideAttestation({ ...ELIGIBLE, lastTerminalKyc: "rejected" })).toEqual({
      ok: false,
      error: "review_required",
      reason: "kyc_rejected",
    })
    expect(decideAttestation({ ...ELIGIBLE, lastTerminalKyc: "approved" })).toMatchObject({
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

  test("une inscription consulaire exige une nationalité gabonaise", () => {
    for (const nationality of ["CM", "FRANCE", "GABONAIS DE COEUR"]) {
      expect(decideAttestation({ ...ELIGIBLE, nationality })).toEqual({
        ok: false,
        error: "not_eligible",
        reason: "nationality",
      })
    }
  })

  test("une identité modifiée après la lecture du partenaire est périmée", () => {
    expect(
      decideAttestation({ ...ELIGIBLE, pivotUpdatedAt: 2_000, identityReadAt: 1_999 }),
    ).toEqual({ ok: false, error: "identity_stale" })
    // Lue après la modification, ou jamais modifiée depuis la mise en service.
    expect(
      decideAttestation({ ...ELIGIBLE, pivotUpdatedAt: 2_000, identityReadAt: 2_000 }),
    ).toMatchObject({ ok: true, outcome: "applied" })
    expect(
      decideAttestation({ ...ELIGIBLE, pivotUpdatedAt: null, identityReadAt: 0 }),
    ).toMatchObject({ ok: true, outcome: "applied" })
  })

  test("ordre : idempotence d'abord, puis éligibilité et revue, puis fraîcheur", () => {
    const stale = { pivotUpdatedAt: 2_000, identityReadAt: 0 }
    expect(
      decideAttestation({ ...ELIGIBLE, ...stale, activeAttestation: { attestedAt: 7 } }),
    ).toMatchObject({ ok: true, outcome: "already_attested" })
    expect(
      decideAttestation({ ...ELIGIBLE, ...stale, lastTerminalKyc: "rejected" }),
    ).toMatchObject({ ok: false, reason: "kyc_rejected" })
    expect(
      decideAttestation({ ...ELIGIBLE, ...stale, nationality: "CM" }),
    ).toMatchObject({ ok: false, reason: "nationality" })
    // Le compte déjà au Niveau 3 est lui aussi soumis à la fraîcheur.
    expect(decideAttestation({ ...ELIGIBLE, ...stale, loa: 3 })).toEqual({
      ok: false,
      error: "identity_stale",
    })
  })
})

describe("dernière décision KYC", () => {
  test("refus puis nouvelle demande en attente : le refus compte toujours", () => {
    expect(
      lastTerminalKycDecision([
        { status: "rejected", decidedAt: 100 },
        { status: "pending", decidedAt: 200 },
      ]),
    ).toBe("rejected")
  })

  test("refus puis approbation plus récente : approuvé", () => {
    expect(
      lastTerminalKycDecision([
        { status: "rejected", decidedAt: 100 },
        { status: "approved", decidedAt: 200 },
      ]),
    ).toBe("approved")
  })

  test("approbation puis refus plus récent : refusé", () => {
    expect(
      lastTerminalKycDecision([
        { status: "approved", decidedAt: 100 },
        { status: "rejected", decidedAt: 200 },
      ]),
    ).toBe("rejected")
  })

  test("aucune décision : rien à opposer", () => {
    expect(lastTerminalKycDecision([])).toBeNull()
    expect(
      lastTerminalKycDecision([
        { status: "submitted", decidedAt: 1 },
        { status: "under_review", decidedAt: 2 },
        { status: "expired", decidedAt: 3 },
      ]),
    ).toBeNull()
  })
})

describe("nationalité gabonaise", () => {
  test("les graphies admises, après rognage, majuscules et accents retirés", () => {
    for (const value of [
      "GA",
      "gab",
      " Gabon ",
      "GABONAIS",
      "gabonaise",
      "Gabonese",
      "GABONÈSE",
    ]) {
      expect(isGaboneseNationality(value)).toBe(true)
    }
  })

  test("toute autre valeur est refusée", () => {
    for (const value of ["CM", "FRANCE", "FR", "", "  ", "GABONAIS(E)", "G A"]) {
      expect(isGaboneseNationality(value)).toBe(false)
    }
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
