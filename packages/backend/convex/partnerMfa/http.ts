import type { HttpRouter } from "convex/server"

import { components, internal } from "../_generated/api"
import { httpAction, type ActionCtx } from "../_generated/server"
import {
  admitPartnerClient,
  parseBasicCredentials,
  type AuthenticatedPartnerClient,
  type PartnerClientRow,
} from "../lib/partnerClientAuth"
import {
  parseCreateRequestBody,
  parseIdBody,
  parseIdQuery,
  parseSubBody,
  parseSubQuery,
  parseTotpBody,
} from "./rules"

/**
 * API « confirmation de connexion » pour les partenaires (ADR-0007 §6).
 *
 * Serveur à serveur : pas de CORS. Authentification `Authorization: Basic`
 * (client_id:client_secret), puis liste blanche `IDN_MFA_CLIENT_IDS`. Les deux
 * refus diffèrent : un secret faux donne 401 même pour un client non autorisé,
 * pour ne pas révéler la liste à un appelant anonyme.
 */

const JSON_HEADERS = { "Content-Type": "application/json" }

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS })
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

/** Authentifie le partenaire appelant. Renvoie sa réponse d'erreur sinon. */
async function authenticatePartner(
  ctx: ActionCtx,
  request: Request,
): Promise<{ client: AuthenticatedPartnerClient } | { response: Response }> {
  const credentials = parseBasicCredentials(request.headers.get("authorization"))
  if (!credentials) {
    return {
      response: fail(401, "invalid_client", "Authentification Basic requise."),
    }
  }
  // Lecture du client via le composant Better Auth (oauthApplication), comme
  // `validateBearerPrincipal` dans http.ts : une action peut lire le composant.
  const row = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
    model: "oauthApplication",
    where: [
      {
        field: "clientId",
        value: credentials.clientId,
        operator: "eq",
      },
    ],
  })) as PartnerClientRow | null
  const admission = await admitPartnerClient(
    row,
    credentials.clientSecret,
    process.env.IDN_MFA_CLIENT_IDS,
  )
  if (!admission.ok) {
    return {
      response:
        admission.error === "invalid_client"
          ? fail(401, "invalid_client", "Client ou secret invalide.")
          : fail(
              403,
              "client_not_allowed",
              "Ce client n'est pas autorisé à utiliser cette API.",
            ),
    }
  }
  return { client: admission.client }
}

/** Erreurs métier communes aux demandes et aux codes TOTP. */
const FAILURES = {
  rate_limited: [429, "rate_limited", "Trop de demandes pour ce citoyen. Réessayez plus tard."],
  unknown_subject: [404, "unknown_subject", "Aucun compte ne correspond à ce sujet."],
  not_linked: [409, "not_linked", "Ce citoyen n'a pas activé la confirmation pour ce service."],
  no_device: [409, "no_device", "Ce citoyen n'a aucun appareil de confiance enregistré."],
} as const

function failureFrom(code: keyof typeof FAILURES): Response {
  const [status, error, message] = FAILURES[code]
  return fail(status, error, message)
}

// POST /partner-mfa/v1/requests
const createRequestHandler = httpAction(async (ctx, request) => {
  const auth = await authenticatePartner(ctx, request)
  if ("response" in auth) return auth.response
  const raw = await readJsonBody(request)
  if (!raw.ok) return raw.response
  const parsed = parseCreateRequestBody(raw.body)
  if (!parsed.ok) return fail(400, "invalid_request", parsed.message)

  const result = await ctx.runMutation(internal.partnerMfa.requests.createRequest, {
    clientId: auth.client.clientId,
    clientName: auth.client.name,
    clientIcon: auth.client.icon ?? undefined,
    sub: parsed.value.sub,
    kind: parsed.value.kind,
    actionLabel: parsed.value.actionLabel,
    context: parsed.value.context,
  })
  if (!result.ok) return failureFrom(result.error)
  return json(
    {
      requestId: result.requestId,
      number: result.number,
      expiresAt: result.expiresAt,
    },
    201,
  )
})

// GET /partner-mfa/v1/requests/status?id=
const requestStatusHandler = httpAction(async (ctx, request) => {
  const auth = await authenticatePartner(ctx, request)
  if ("response" in auth) return auth.response
  const id = parseIdQuery(new URL(request.url).searchParams.get("id"))
  if (!id.ok) return fail(400, "invalid_request", id.message)

  const row = await ctx.runQuery(internal.partnerMfa.requests.partnerStatus, {
    clientId: auth.client.clientId,
    requestId: id.value,
  })
  if (!row) return fail(404, "not_found", "Demande introuvable.")
  return json(
    row.decidedAt === undefined
      ? { status: row.status }
      : { status: row.status, decidedAt: row.decidedAt },
    200,
  )
})

// POST /partner-mfa/v1/requests/cancel
const cancelRequestHandler = httpAction(async (ctx, request) => {
  const auth = await authenticatePartner(ctx, request)
  if ("response" in auth) return auth.response
  const raw = await readJsonBody(request)
  if (!raw.ok) return raw.response
  const parsed = parseIdBody(raw.body)
  if (!parsed.ok) return fail(400, "invalid_request", parsed.message)

  const result = await ctx.runMutation(internal.partnerMfa.requests.partnerCancel, {
    clientId: auth.client.clientId,
    requestId: parsed.value,
  })
  if (result.ok) return json({ ok: true }, 200)
  if (result.error === "not_found") return fail(404, "not_found", "Demande introuvable.")
  return json(
    {
      error: "request_closed",
      message: "Cette demande est déjà tranchée.",
      status: result.status,
    },
    409,
  )
})

// POST /partner-mfa/v1/totp/verify
const totpVerifyHandler = httpAction(async (ctx, request) => {
  const auth = await authenticatePartner(ctx, request)
  if ("response" in auth) return auth.response
  const raw = await readJsonBody(request)
  if (!raw.ok) return raw.response
  const parsed = parseTotpBody(raw.body)
  if (!parsed.ok) return fail(400, "invalid_request", parsed.message)

  const result = await ctx.runMutation(internal.partnerMfa.totp.verifyCode, {
    clientId: auth.client.clientId,
    sub: parsed.value.sub,
    code: parsed.value.code,
  })
  if (!result.ok) return failureFrom(result.error)
  return json({ valid: result.valid }, 200)
})

// GET /partner-mfa/v1/links/status?sub=
const linkStatusHandler = httpAction(async (ctx, request) => {
  const auth = await authenticatePartner(ctx, request)
  if ("response" in auth) return auth.response
  const parsed = parseSubQuery(new URL(request.url).searchParams.get("sub"))
  if (!parsed.ok) return fail(400, "invalid_request", parsed.message)

  const result = await ctx.runQuery(internal.partnerMfa.links.linkStatus, {
    clientId: auth.client.clientId,
    sub: parsed.value,
  })
  if (!result.ok) return fail(404, "unknown_subject", "Aucun compte ne correspond à ce sujet.")
  return json({ linked: result.linked, devices: result.devices }, 200)
})

// POST /partner-mfa/v1/links/revoke
const linkRevokeHandler = httpAction(async (ctx, request) => {
  const auth = await authenticatePartner(ctx, request)
  if ("response" in auth) return auth.response
  const raw = await readJsonBody(request)
  if (!raw.ok) return raw.response
  const parsed = parseSubBody(raw.body)
  if (!parsed.ok) return fail(400, "invalid_request", parsed.message)

  const result = await ctx.runMutation(internal.partnerMfa.links.revokeForSubject, {
    clientId: auth.client.clientId,
    sub: parsed.value,
  })
  if (!result.ok) return fail(404, "unknown_subject", "Aucun compte ne correspond à ce sujet.")
  return json({ ok: true }, 200)
})

export function registerPartnerMfaRoutes(http: HttpRouter): void {
  http.route({
    path: "/partner-mfa/v1/requests",
    method: "POST",
    handler: createRequestHandler,
  })
  http.route({
    path: "/partner-mfa/v1/requests/status",
    method: "GET",
    handler: requestStatusHandler,
  })
  http.route({
    path: "/partner-mfa/v1/requests/cancel",
    method: "POST",
    handler: cancelRequestHandler,
  })
  http.route({
    path: "/partner-mfa/v1/totp/verify",
    method: "POST",
    handler: totpVerifyHandler,
  })
  http.route({
    path: "/partner-mfa/v1/links/status",
    method: "GET",
    handler: linkStatusHandler,
  })
  http.route({
    path: "/partner-mfa/v1/links/revoke",
    method: "POST",
    handler: linkRevokeHandler,
  })
}
