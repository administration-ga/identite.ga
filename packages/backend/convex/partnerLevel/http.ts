import type { HttpRouter } from "convex/server"

import { components, internal } from "../_generated/api"
import { httpAction, type ActionCtx } from "../_generated/server"
import {
  authenticatePartnerClient,
  parseBasicCredentials,
  type AuthenticatedPartnerClient,
  type PartnerClientRow,
} from "../lib/partnerClientAuth"
import { parseAttestBody, parseWithdrawBody } from "./rules"

/**
 * API « attestation de niveau » pour les partenaires — contrat
 * IDN-ATTESTATION-NIVEAU-V1 (ADR 0003, `docs/level-attestation-api.md`).
 *
 * Serveur à serveur : pas de CORS. Authentification `Authorization: Basic`
 * (client_id:client_secret, le secret OAuth que le partenaire détient déjà),
 * puis capacité en base (`partnerLevelGrant`, fermée par défaut). Les deux
 * refus diffèrent : un secret faux donne 401 même pour un client sans
 * capacité, pour ne pas révéler à un appelant anonyme qui est habilité.
 *
 * Rien d'interne ne traverse : ni identifiant Convex, ni état civil. La
 * réponse ne porte que le résultat, le niveau et son `acr`.
 */

const JSON_HEADERS = { "Content-Type": "application/json" }

function json(
  payload: unknown,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  })
}

function fail(status: number, error: string, message: string): Response {
  return json({ error, message }, status)
}

async function readJsonBody(
  request: Request,
): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  try {
    return { ok: true, body: await request.json() }
  } catch {
    return { ok: false, response: fail(400, "invalid_request", "Corps JSON invalide.") }
  }
}

/**
 * Authentifie le partenaire (401), puis vérifie qu'il détient au moins une
 * capacité active (403). La capacité du type de fait demandé est revérifiée
 * dans la mutation, qui fait foi.
 */
async function admitPartner(
  ctx: ActionCtx,
  request: Request,
): Promise<{ client: AuthenticatedPartnerClient } | { response: Response }> {
  const credentials = parseBasicCredentials(request.headers.get("authorization"))
  if (!credentials) {
    return { response: fail(401, "invalid_client", "Authentification Basic requise.") }
  }
  // Lecture du client via le composant Better Auth, comme `partnerMfa/http.ts`.
  const row = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
    model: "oauthApplication",
    where: [{ field: "clientId", value: credentials.clientId, operator: "eq" }],
  })) as PartnerClientRow | null
  const client = await authenticatePartnerClient(row, credentials.clientSecret)
  if (!client) {
    return { response: fail(401, "invalid_client", "Client ou secret invalide.") }
  }
  const enabled = await ctx.runQuery(
    internal.partnerLevel.attestations.hasActiveCapability,
    { clientId: client.clientId },
  )
  if (!enabled) return { response: failureFrom({ error: "attestation_not_enabled" }) }
  return { client }
}

type Failure = {
  error:
    | "attestation_not_enabled"
    | "rate_limited"
    | "unknown_subject"
    | "not_linked"
    | "not_eligible"
    | "review_required"
  reason?: string
  retryAfter?: number
}

const FAILURES: Record<Failure["error"], [number, string]> = {
  attestation_not_enabled: [403, "Ce client n'est pas habilité à attester un niveau."],
  rate_limited: [429, "Trop d'appels pour ce client. Réessayez plus tard."],
  unknown_subject: [404, "Aucun compte ne correspond à ce sujet."],
  not_linked: [409, "Ce citoyen n'a pas donné son consentement à ce service."],
  review_required: [409, "Ce compte demande une revue humaine avant toute attestation."],
  not_eligible: [422, "Ce compte ne remplit pas les conditions de l'attestation."],
}

/** Messages précis par motif, lisibles par l'équipe du partenaire. */
const REASON_MESSAGES: Record<string, string> = {
  profile_incomplete:
    "Le profil de ce compte est incomplet : nom, prénom, date de naissance ou nationalité manquant.",
  profile_type: "Seul un compte de citoyen peut recevoir cette attestation.",
  account_closing: "La suppression de ce compte a été demandée.",
  kyc_rejected:
    "La dernière vérification d'identité de ce compte a été refusée : une revue humaine est nécessaire.",
  duplicate_flag_open:
    "Un signalement de doublon est ouvert sur ce compte : une revue humaine est nécessaire.",
}

function failureFrom(failure: Failure): Response {
  const [status, fallback] = FAILURES[failure.error]
  const message = (failure.reason && REASON_MESSAGES[failure.reason]) || fallback
  const headers: Record<string, string> =
    failure.error === "rate_limited" && failure.retryAfter !== undefined
      ? { "Retry-After": String(Math.max(1, Math.ceil(failure.retryAfter / 1000))) }
      : {}
  return json(
    {
      error: failure.error,
      message,
      ...(failure.reason ? { reason: failure.reason } : {}),
    },
    status,
    headers,
  )
}

// POST /partner-level/v1/attestations
const attestHandler = httpAction(async (ctx, request) => {
  const admission = await admitPartner(ctx, request)
  if ("response" in admission) return admission.response
  const raw = await readJsonBody(request)
  if (!raw.ok) return raw.response
  const parsed = parseAttestBody(raw.body)
  if (!parsed.ok) return fail(400, "invalid_request", parsed.message)

  const result = await ctx.runMutation(internal.partnerLevel.attestations.attest, {
    clientId: admission.client.clientId,
    clientName: admission.client.name,
    sub: parsed.value.sub,
    kind: parsed.value.kind,
    dryRun: parsed.value.dryRun,
  })
  if (!result.ok) return failureFrom(result)
  return json(
    {
      outcome: result.outcome,
      loa: result.loa,
      acr: result.acr,
      attestedAt: result.attestedAt,
      dryRun: result.dryRun,
    },
    200,
  )
})

// POST /partner-level/v1/attestations/withdraw
const withdrawHandler = httpAction(async (ctx, request) => {
  const admission = await admitPartner(ctx, request)
  if ("response" in admission) return admission.response
  const raw = await readJsonBody(request)
  if (!raw.ok) return raw.response
  const parsed = parseWithdrawBody(raw.body)
  if (!parsed.ok) return fail(400, "invalid_request", parsed.message)

  const result = await ctx.runMutation(internal.partnerLevel.attestations.withdraw, {
    clientId: admission.client.clientId,
    clientName: admission.client.name,
    sub: parsed.value.sub,
    kind: parsed.value.kind,
    dryRun: parsed.value.dryRun,
  })
  if (!result.ok) return failureFrom(result)
  return json(
    {
      outcome: result.outcome,
      loa: result.loa,
      acr: result.acr,
      dryRun: result.dryRun,
    },
    200,
  )
})

export function registerPartnerLevelRoutes(http: HttpRouter): void {
  http.route({
    path: "/partner-level/v1/attestations",
    method: "POST",
    handler: attestHandler,
  })
  http.route({
    path: "/partner-level/v1/attestations/withdraw",
    method: "POST",
    handler: withdrawHandler,
  })
}
