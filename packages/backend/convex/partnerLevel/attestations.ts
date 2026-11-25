import { paginationOptsValidator } from "convex/server"
import { ConvexError, v } from "convex/values"

import { components, internal } from "../_generated/api"
import type { Doc } from "../_generated/dataModel"
import { internalQuery, type MutationCtx } from "../_generated/server"
import { internalMutation } from "../functions"
import type { PartnerClientRow } from "../lib/partnerClientAuth"
import { rateLimiter } from "../rateLimiter"
import {
  ATTESTATION_KINDS,
  acrFor,
  decideAttestation,
  decideWithdrawal,
  isPivotComplete,
  type AttestationKind,
  type WithdrawalDecision,
} from "./rules"
import {
  activeAttestationsOf,
  activeGrantOf,
  attestationRowOf,
  hasApprovedKyc,
  hasOpenDuplicateFlag,
  hasRecordedConsent,
  lastTerminalKycOf,
} from "./store"

/**
 * Attestation de niveau par un partenaire — contrat IDN-ATTESTATION-NIVEAU-V1
 * (ADR 0003, documentation `docs/level-attestation-api.md`).
 *
 * Règle du propriétaire (25/11/2026) : tout ressortissant gabonais qui a ouvert
 * son inscription consulaire dans consulat.ga est par défaut au Niveau 2 sur
 * son compte IDN associé.
 *
 * Partage des rôles : le partenaire ATTESTE un fait, IDN seul DÉCIDE et ÉCRIT
 * `userProfile.loa`. `attest`, `withdraw` et `operatorWithdraw` sont les seuls
 * écrivains du niveau pour cette voie ; ils passent par les mutations de
 * `../functions` pour que l'agrégat `usersByLoa` suive (cf. l'avertissement de
 * `partner/verifications.ts`). Aucune fausse demande KYC, aucune empreinte
 * faciale : un Niveau 2 attesté se reconnaît en base (table `levelAttestation`)
 * et n'est pas pris pour une preuve documentaire (`verification/documentProof.ts`).
 *
 * La capacité d'un client est FERMÉE PAR DÉFAUT : elle s'ouvre par
 * `grantCapability`, geste d'opérateur (`convex run`), jamais par une variable
 * d'environnement.
 */

const KIND = v.union(...ATTESTATION_KINDS.map((kind) => v.literal(kind)))
const LOA = v.union(v.literal(1), v.literal(2), v.literal(3))
const ACR = v.union(v.literal("eidas1"), v.literal("eidas2"), v.literal("eidas3"))

const REQUEST_ARGS = {
  clientId: v.string(),
  /** Nom d'affichage du client authentifié, pour la notification. */
  clientName: v.string(),
  sub: v.string(),
  kind: KIND,
  dryRun: v.boolean(),
}

const NOT_ENABLED = v.object({
  ok: v.literal(false),
  error: v.literal("attestation_not_enabled"),
})
const RATE_LIMITED = v.object({
  ok: v.literal(false),
  error: v.literal("rate_limited"),
  retryAfter: v.number(),
})
const UNKNOWN_SUBJECT = v.object({
  ok: v.literal(false),
  error: v.literal("unknown_subject"),
})
const NOT_LINKED = v.object({ ok: v.literal(false), error: v.literal("not_linked") })

/** Attestations traitées au plus par appel de `operatorWithdraw`. */
const OPERATOR_WITHDRAW_PAGE_MAX = 100

/** Ce que dit la notification, selon le fait attesté. */
const FACT_LABEL: Record<AttestationKind, string> = {
  consular_registration: "votre inscription consulaire",
}

type RequestArgs = {
  clientId: string
  clientName: string
  sub: string
  kind: AttestationKind
  dryRun: boolean
}

/**
 * Profil vivant désigné par le sujet OIDC. Le `sub` d'IDN est l'identifiant
 * Better Auth, celui que porte `userProfile.userId` : un compte sans profil,
 * ou anonymisé, est un sujet inconnu pour le partenaire.
 */
async function liveProfileOf(
  ctx: MutationCtx,
  sub: string,
): Promise<Doc<"userProfile"> | null> {
  const profile = await ctx.db
    .query("userProfile")
    .withIndex("by_userId", (q) => q.eq("userId", sub))
    .unique()
  return profile && !profile.deletedAt ? profile : null
}

/**
 * Trace un refus. Jamais en `dryRun`, et seulement APRÈS le plafond du client :
 * les refus 403 et 429, non plafonnés, ne doivent pas pouvoir remplir le
 * journal. Aucune donnée d'état civil, ni le `sub` d'un sujet inconnu (valeur
 * fournie par l'appelant).
 */
async function recordRefusal(
  ctx: MutationCtx,
  args: RequestArgs,
  operation: "attest" | "withdraw",
  userId: string | null,
  refusal: { error: string; reason?: string },
): Promise<void> {
  if (args.dryRun) return
  await ctx.runMutation(internal.audit.recordAudit, {
    actorId: undefined, // appel serveur à serveur d'un partenaire
    action: "level_attestation_refused",
    targetType: userId ? "user" : "app",
    targetId: userId ?? args.clientId,
    metadata: {
      clientId: args.clientId,
      kind: args.kind,
      operation,
      error: refusal.error,
      ...(refusal.reason ? { reason: refusal.reason } : {}),
    },
  })
}

/** Plafond par client, consommé même par un refus ou un `dryRun`. */
async function consumeQuota(
  ctx: MutationCtx,
  clientId: string,
): Promise<{ ok: true } | { ok: false; retryAfter: number }> {
  const limit = await rateLimiter.limit(ctx, "partnerLevelAttest", {
    key: clientId,
    throws: false,
  })
  return limit.ok ? { ok: true } : { ok: false, retryAfter: limit.retryAfter }
}

/**
 * Décide le retrait d'UNE attestation active, sans rien écrire. Partagé par
 * `withdraw` (partenaire) et `operatorWithdraw` (opérateur) : une seule règle.
 * `profile` absent (compte sans profil) : rien à faire redescendre.
 */
async function planWithdrawal(
  ctx: MutationCtx,
  active: Doc<"levelAttestation">,
  profile: Doc<"userProfile"> | null,
): Promise<{ decision: WithdrawalDecision; others: Doc<"levelAttestation">[] }> {
  const others = (await activeAttestationsOf(ctx, active.userId)).filter(
    (row) => row._id !== active._id,
  )
  const decision = decideWithdrawal({
    attestation: { previousLoa: active.previousLoa, raised: active.raised },
    loa: profile?.loa ?? active.previousLoa,
    hasApprovedKyc: await hasApprovedKyc(ctx, active.userId),
    otherActiveAttestations: others.length,
  })
  if (!profile && decision.outcome === "withdrawn") {
    return { decision: { outcome: "kept", loa: decision.loa, transferRaise: false }, others }
  }
  return { decision, others }
}

/**
 * Écrit le retrait décidé par `planWithdrawal` : attestation close, charge
 * transférée à l'attestation active la plus ancienne s'il y a lieu, niveau
 * ramené, journal, notification de la personne si son niveau baisse.
 */
async function applyWithdrawal(
  ctx: MutationCtx,
  input: {
    active: Doc<"levelAttestation">
    profile: Doc<"userProfile"> | null
    decision: WithdrawalDecision
    others: Doc<"levelAttestation">[]
    clientName: string
    /** Ajouts au journal (opérateur, par exemple). */
    auditExtra?: Record<string, string>
    /** Retrait décidé par identite.ga, et non par le partenaire. */
    byOperator?: boolean
  },
): Promise<void> {
  const { active, profile, decision, others } = input
  if (decision.outcome === "not_attested") return
  const now = Date.now()
  await ctx.db.patch(active._id, {
    status: "withdrawn",
    withdrawnAt: now,
    updatedAt: now,
  })

  let heir: Doc<"levelAttestation"> | undefined
  if (decision.outcome === "kept" && decision.transferRaise) {
    // L'attestation active la plus ancienne reprend la charge d'avoir monté
    // le compte : c'est son retrait qui, plus tard, le fera redescendre.
    heir = [...others].sort((a, b) => a.attestedAt - b.attestedAt)[0]
    if (heir) {
      await ctx.db.patch(heir._id, {
        raised: true,
        previousLoa: active.previousLoa,
        updatedAt: now,
      })
    }
  }

  const lowered =
    profile !== null && decision.outcome === "withdrawn" && decision.loa !== profile.loa
  if (lowered) {
    await ctx.db.patch(profile._id, { loa: decision.loa, updatedAt: now })
  }

  await ctx.runMutation(internal.audit.recordAudit, {
    actorId: undefined,
    action: "level_attestation_withdrawn",
    targetType: "user",
    targetId: active.userId,
    metadata: {
      clientId: active.clientId,
      kind: active.kind,
      outcome: decision.outcome,
      previousLoa: active.previousLoa,
      loa: decision.loa,
      ...(heir ? { raiseTransferredTo: heir.clientId } : {}),
      ...(input.auditExtra ?? {}),
    },
  })

  if (lowered) {
    await ctx.runMutation(internal.notifications.dispatch, {
      userId: active.userId,
      category: "kyc",
      title: `Votre identité revient au Niveau ${decision.loa}`,
      // Le message dit QUI a retiré : le partenaire, ou identite.ga elle-même.
      body: `${
        input.byOperator
          ? `La confirmation de ${FACT_LABEL[active.kind]} apportée par ${input.clientName} a été retirée par identite.ga.`
          : `${input.clientName} a retiré la confirmation de ${FACT_LABEL[active.kind]}.`
      } Votre identité numérique revient au Niveau ${decision.loa}. Vous pouvez faire vérifier votre identité depuis votre espace pour retrouver le Niveau 2.`,
      metadata: { kind: "level_attestation_withdrawn", clientId: active.clientId },
      sendEmail: true,
      pushUrl: "/kyc",
    })
  }
}

// ---------------------------------------------------------------------------
// Côté partenaire (HTTP, via partnerLevel/http.ts)
// ---------------------------------------------------------------------------

/** `POST /partner-level/v1/attestations`. */
export const attest = internalMutation({
  args: {
    ...REQUEST_ARGS,
    /** Lecture de l'identité par le partenaire (ms), 0 si inconnue. */
    identityReadAt: v.number(),
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      outcome: v.union(
        v.literal("applied"),
        v.literal("already_attested"),
        v.literal("recorded"),
      ),
      loa: LOA,
      acr: ACR,
      attestedAt: v.number(),
      dryRun: v.boolean(),
    }),
    NOT_ENABLED,
    RATE_LIMITED,
    UNKNOWN_SUBJECT,
    NOT_LINKED,
    v.object({
      ok: v.literal(false),
      error: v.literal("not_eligible"),
      reason: v.union(
        v.literal("profile_incomplete"),
        v.literal("profile_type"),
        v.literal("account_closing"),
        v.literal("nationality"),
      ),
    }),
    v.object({
      ok: v.literal(false),
      error: v.literal("review_required"),
      reason: v.union(v.literal("kyc_rejected"), v.literal("duplicate_flag_open")),
    }),
    v.object({ ok: v.literal(false), error: v.literal("identity_stale") }),
  ),
  handler: async (ctx, args) => {
    const grant = await activeGrantOf(ctx, args.clientId, args.kind)
    if (!grant) return { ok: false as const, error: "attestation_not_enabled" as const }

    // Plafond par client, consommé même par un refus ou un `dryRun` : sinon
    // l'API deviendrait un oracle illimité sur les comptes.
    const quota = await consumeQuota(ctx, args.clientId)
    if (!quota.ok) {
      return {
        ok: false as const,
        error: "rate_limited" as const,
        retryAfter: quota.retryAfter,
      }
    }

    const profile = await liveProfileOf(ctx, args.sub)
    if (!profile) {
      await recordRefusal(ctx, args, "attest", null, { error: "unknown_subject" })
      return { ok: false as const, error: "unknown_subject" as const }
    }
    const userId = profile.userId

    const row = await attestationRowOf(ctx, args.clientId, args.kind, userId)

    // Le partenaire n'atteste que pour une personne qui lui a donné son
    // consentement : il ne peut pas viser un compte qu'il ne connaît pas.
    // Une attestation DÉJÀ ACTIVE prouve un consentement passé : le rejeu
    // répond alors `already_attested`, même consentement retiré depuis. Sans
    // cela, un partenaire dont la première réponse s'est perdue recevrait
    // `not_linked`, croirait qu'IDN ne tient rien et ne retirerait jamais.
    if (
      row?.status !== "active" &&
      !(await hasRecordedConsent(ctx, userId, args.clientId))
    ) {
      await recordRefusal(ctx, args, "attest", userId, { error: "not_linked" })
      return { ok: false as const, error: "not_linked" as const }
    }

    const decision = decideAttestation({
      kind: args.kind,
      loa: profile.loa,
      profileType: profile.profileType,
      pivotComplete: isPivotComplete(profile.pivot),
      nationality: profile.pivot?.nationality ?? null,
      closing:
        profile.deletionRequestedAt !== undefined ||
        profile.deletionScheduledAt !== undefined,
      // La dernière DÉCISION, pas la dernière demande : une demande vide
      // rouverte après un refus ne l'efface pas (revue de sécurité, point A).
      lastTerminalKyc: await lastTerminalKycOf(ctx, userId),
      openDuplicateFlag: await hasOpenDuplicateFlag(ctx, userId),
      pivotUpdatedAt: profile.pivotUpdatedAt ?? null,
      identityReadAt: args.identityReadAt,
      activeAttestation:
        row?.status === "active" ? { attestedAt: row.attestedAt } : null,
      maxLoa: grant.maxLoa,
    })

    if (!decision.ok) {
      await recordRefusal(ctx, args, "attest", userId, decision)
      if (decision.error === "not_eligible") {
        return { ok: false as const, error: "not_eligible" as const, reason: decision.reason }
      }
      if (decision.error === "review_required") {
        return { ok: false as const, error: "review_required" as const, reason: decision.reason }
      }
      return { ok: false as const, error: "identity_stale" as const }
    }

    if (decision.outcome === "already_attested") {
      return {
        ok: true as const,
        outcome: decision.outcome,
        loa: decision.loa,
        acr: acrFor(decision.loa),
        attestedAt: decision.attestedAt,
        dryRun: args.dryRun,
      }
    }

    const now = Date.now()
    if (args.dryRun) {
      // Tout est évalué, rien n'est écrit : ni ligne, ni journal, ni
      // notification. Le partenaire voit l'effet qu'aurait l'appel.
      return {
        ok: true as const,
        outcome: decision.outcome,
        loa: decision.loa,
        acr: acrFor(decision.loa),
        attestedAt: now,
        dryRun: true,
      }
    }

    // Clé d'idempotence (client, sujet, type) : une attestation après un
    // retrait RÉACTIVE la même ligne au lieu d'en créer une seconde.
    if (row) {
      await ctx.db.patch(row._id, {
        status: "active",
        previousLoa: decision.previousLoa,
        raised: decision.raised,
        attestedAt: now,
        withdrawnAt: undefined,
        updatedAt: now,
      })
    } else {
      await ctx.db.insert("levelAttestation", {
        userId,
        clientId: args.clientId,
        kind: args.kind,
        status: "active",
        previousLoa: decision.previousLoa,
        raised: decision.raised,
        attestedAt: now,
        updatedAt: now,
      })
    }
    if (decision.outcome === "applied") {
      await ctx.db.patch(profile._id, { loa: decision.loa, updatedAt: now })
    }

    await ctx.runMutation(internal.audit.recordAudit, {
      actorId: undefined,
      action: "level_attested",
      targetType: "user",
      targetId: userId,
      metadata: {
        clientId: args.clientId,
        kind: args.kind,
        outcome: decision.outcome,
        previousLoa: decision.previousLoa,
        loa: decision.loa,
      },
    })

    if (decision.outcome === "applied") {
      await ctx.runMutation(internal.notifications.dispatch, {
        userId,
        category: "kyc",
        title: "Votre identité passe au Niveau 2",
        body: `${args.clientName} a confirmé ${FACT_LABEL[args.kind]}. Votre identité numérique passe au Niveau 2 : davantage de services vous sont ouverts.`,
        metadata: { kind: "level_attested", clientId: args.clientId },
        sendEmail: true,
        pushUrl: "/kyc",
      })
    }

    return {
      ok: true as const,
      outcome: decision.outcome,
      loa: decision.loa,
      acr: acrFor(decision.loa),
      attestedAt: now,
      dryRun: false,
    }
  },
})

/** `POST /partner-level/v1/attestations/withdraw`. */
export const withdraw = internalMutation({
  args: REQUEST_ARGS,
  returns: v.union(
    v.object({
      ok: v.literal(true),
      outcome: v.union(
        v.literal("withdrawn"),
        v.literal("kept"),
        v.literal("not_attested"),
      ),
      loa: LOA,
      acr: ACR,
      dryRun: v.boolean(),
    }),
    NOT_ENABLED,
    RATE_LIMITED,
    UNKNOWN_SUBJECT,
    NOT_LINKED,
  ),
  handler: async (ctx, args) => {
    const grant = await activeGrantOf(ctx, args.clientId, args.kind)
    if (!grant) return { ok: false as const, error: "attestation_not_enabled" as const }

    const quota = await consumeQuota(ctx, args.clientId)
    if (!quota.ok) {
      return {
        ok: false as const,
        error: "rate_limited" as const,
        retryAfter: quota.retryAfter,
      }
    }

    const profile = await liveProfileOf(ctx, args.sub)
    if (!profile) {
      await recordRefusal(ctx, args, "withdraw", null, { error: "unknown_subject" })
      return { ok: false as const, error: "unknown_subject" as const }
    }
    const userId = profile.userId

    const row = await attestationRowOf(ctx, args.clientId, args.kind, userId)
    if (!row) {
      // Jamais rien attesté pour ce sujet : sans consentement, répondre
      // `not_attested` avec le niveau ferait de la route un oracle sur tout
      // compte existant (revue de sécurité, point D).
      if (!(await hasRecordedConsent(ctx, userId, args.clientId))) {
        await recordRefusal(ctx, args, "withdraw", userId, { error: "not_linked" })
        return { ok: false as const, error: "not_linked" as const }
      }
    }
    // Une ligne existe (active ou retirée) : pas d'exigence de consentement.
    // Un citoyen qui a retiré son consentement ne doit pas figer pour toujours
    // une attestation que le partenaire veut lever.

    if (row?.status !== "active") {
      return {
        ok: true as const,
        outcome: "not_attested" as const,
        loa: profile.loa,
        acr: acrFor(profile.loa),
        dryRun: args.dryRun,
      }
    }

    const { decision, others } = await planWithdrawal(ctx, row, profile)
    if (!args.dryRun) {
      await applyWithdrawal(ctx, {
        active: row,
        profile,
        decision,
        others,
        clientName: args.clientName,
      })
    }
    return {
      ok: true as const,
      outcome: decision.outcome,
      loa: decision.loa,
      acr: acrFor(decision.loa),
      dryRun: args.dryRun,
    }
  },
})

// ---------------------------------------------------------------------------
// Côté opérateur (`npx convex run partnerLevel/attestations:…`)
// ---------------------------------------------------------------------------

/**
 * Ouvre la capacité d'attester pour un client. Refuse un client absent,
 * public (sans secret, il ne pourrait pas s'authentifier) ou désactivé.
 * Idempotent ; rouvre une capacité fermée. Tracé par `admin_action`.
 */
export const grantCapability = internalMutation({
  args: { clientId: v.string(), kind: KIND, grantedBy: v.string() },
  returns: v.object({
    clientName: v.string(),
    status: v.union(
      v.literal("granted"),
      v.literal("reactivated"),
      v.literal("already_granted"),
    ),
  }),
  handler: async (ctx, args) => {
    const grantedBy = args.grantedBy.trim()
    if (!grantedBy) {
      throw new ConvexError({
        code: "INVALID",
        message: "Indiquez qui ouvre la capacité (grantedBy).",
      })
    }
    const app = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: "oauthApplication",
      where: [{ field: "clientId", value: args.clientId, operator: "eq" }],
    })) as PartnerClientRow | null
    if (!app) {
      throw new ConvexError({
        code: "CLIENT_NOT_FOUND",
        message: "Application OAuth inconnue.",
      })
    }
    if (app.disabled) {
      throw new ConvexError({
        code: "CLIENT_DISABLED",
        message: "Cette application OAuth est désactivée.",
      })
    }
    if (app.type === "public" || !app.clientSecret) {
      throw new ConvexError({
        code: "CLIENT_NOT_CONFIDENTIAL",
        message:
          "Seule une application confidentielle, dotée d'un secret, peut attester un niveau.",
      })
    }
    const clientName = app.name?.trim() || args.clientId

    const existing = await ctx.db
      .query("partnerLevelGrant")
      .withIndex("by_clientId_and_kind", (q) =>
        q.eq("clientId", args.clientId).eq("kind", args.kind),
      )
      .unique()
    if (existing && existing.revokedAt === undefined) {
      return { clientName, status: "already_granted" as const }
    }

    const now = Date.now()
    if (existing) {
      await ctx.db.patch(existing._id, {
        revokedAt: undefined,
        grantedAt: now,
        grantedBy,
      })
    } else {
      await ctx.db.insert("partnerLevelGrant", {
        clientId: args.clientId,
        kind: args.kind,
        maxLoa: 2,
        grantedAt: now,
        grantedBy,
      })
    }
    await ctx.runMutation(internal.audit.recordAudit, {
      actorId: undefined,
      action: "admin_action",
      targetType: "app",
      targetId: args.clientId,
      metadata: {
        kind: "partner_level_capability_granted",
        clientId: args.clientId,
        attestationKind: args.kind,
        maxLoa: 2,
        grantedBy,
      },
    })
    return {
      clientName,
      status: existing ? ("reactivated" as const) : ("granted" as const),
    }
  },
})

/**
 * Ferme la capacité d'un client. Les attestations déjà enregistrées restent
 * en place, avec leur verrou d'état civil ; le client ne peut plus ni attester
 * ni retirer. Pour les lever, l'opérateur lance `operatorWithdraw` (page par
 * page), qui marche capacité ouverte ou fermée. Idempotent, tracé.
 */
export const revokeCapability = internalMutation({
  args: { clientId: v.string(), kind: KIND, revokedBy: v.string() },
  returns: v.object({
    status: v.union(v.literal("revoked"), v.literal("not_granted")),
  }),
  handler: async (ctx, args) => {
    const grant = await activeGrantOf(ctx, args.clientId, args.kind)
    if (!grant) return { status: "not_granted" as const }
    await ctx.db.patch(grant._id, { revokedAt: Date.now() })
    await ctx.runMutation(internal.audit.recordAudit, {
      actorId: undefined,
      action: "admin_action",
      targetType: "app",
      targetId: args.clientId,
      metadata: {
        kind: "partner_level_capability_revoked",
        clientId: args.clientId,
        attestationKind: args.kind,
        revokedBy: args.revokedBy.trim(),
      },
    })
    return { status: "revoked" as const }
  },
})

/**
 * Retrait par l'opérateur des attestations ACTIVES d'un client, UNE page par
 * appel (relancer avec `continueCursor` jusqu'à `isDone`). Même règle et mêmes
 * écritures que le retrait du partenaire (`planWithdrawal`, `applyWithdrawal`) :
 * on ne redescend que ce que l'attestation avait monté, un compte au Niveau 3
 * ou aux pièces approuvées garde son niveau. L'opérateur est inscrit au journal.
 * Marche que la capacité soit encore ouverte ou déjà fermée. Une seconde passe
 * ne trouve plus rien : les attestations traitées ne sont plus actives.
 */
export const operatorWithdraw = internalMutation({
  args: {
    clientId: v.string(),
    kind: KIND,
    operator: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    withdrawn: v.number(),
    kept: v.number(),
    continueCursor: v.string(),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const operator = args.operator.trim()
    if (!operator) {
      throw new ConvexError({
        code: "INVALID",
        message: "Indiquez qui procède au retrait (operator).",
      })
    }
    const app = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: "oauthApplication",
      where: [{ field: "clientId", value: args.clientId, operator: "eq" }],
    })) as PartnerClientRow | null
    const clientName = app?.name?.trim() || args.clientId

    const page = await ctx.db
      .query("levelAttestation")
      .withIndex("by_clientId_and_kind_and_status", (q) =>
        q.eq("clientId", args.clientId).eq("kind", args.kind).eq("status", "active"),
      )
      .paginate({
        ...args.paginationOpts,
        numItems: Math.min(Math.max(1, args.paginationOpts.numItems), OPERATOR_WITHDRAW_PAGE_MAX),
      })

    let withdrawn = 0
    let kept = 0
    for (const active of page.page) {
      const profile = await ctx.db
        .query("userProfile")
        .withIndex("by_userId", (q) => q.eq("userId", active.userId))
        .unique()
      const { decision, others } = await planWithdrawal(ctx, active, profile)
      await applyWithdrawal(ctx, {
        active,
        profile,
        decision,
        others,
        clientName,
        auditExtra: { by: "operator", operator },
        byOperator: true,
      })
      if (decision.outcome === "withdrawn") withdrawn++
      else kept++
    }
    return {
      withdrawn,
      kept,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    }
  },
})

/**
 * Le client détient-il au moins une capacité active ? Lue par la route HTTP
 * juste après l'authentification (403 avant toute lecture du corps, comme
 * `partnerMfa/http.ts`). La capacité du type demandé est revérifiée par
 * `attest` / `withdraw`, dans la même transaction que l'écriture.
 */
export const hasActiveCapability = internalQuery({
  args: { clientId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const grants = await ctx.db
      .query("partnerLevelGrant")
      .withIndex("by_clientId_and_kind", (q) => q.eq("clientId", args.clientId))
      .take(ATTESTATION_KINDS.length + 5)
    return grants.some((grant) => grant.revokedAt === undefined)
  },
})

/**
 * Revue des attestations, les plus récentes d'abord. UNE page par appel
 * (l'opérateur relance avec `continueCursor`).
 */
export const listAttested = internalQuery({
  args: {
    status: v.optional(v.union(v.literal("active"), v.literal("withdrawn"))),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    page: v.array(
      v.object({
        userId: v.string(),
        clientId: v.string(),
        kind: KIND,
        status: v.union(v.literal("active"), v.literal("withdrawn")),
        previousLoa: LOA,
        raised: v.boolean(),
        attestedAt: v.number(),
        withdrawnAt: v.optional(v.number()),
      }),
    ),
    continueCursor: v.string(),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("levelAttestation")
      .withIndex("by_status_and_attestedAt", (q) =>
        q.eq("status", args.status ?? "active"),
      )
      .order("desc")
      .paginate(args.paginationOpts)
    return {
      page: result.page.map((row) => ({
        userId: row.userId,
        clientId: row.clientId,
        kind: row.kind,
        status: row.status,
        previousLoa: row.previousLoa,
        raised: row.raised,
        attestedAt: row.attestedAt,
        withdrawnAt: row.withdrawnAt,
      })),
      continueCursor: result.continueCursor,
      isDone: result.isDone,
    }
  },
})
