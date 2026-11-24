/**
 * Règles pures de la confirmation de connexion (ADR-0007 §6) : tirage du nombre
 * et des choix, statut calculé à la lecture, validation stricte des corps HTTP.
 *
 * Aucune dépendance Convex ici : tout est testable directement.
 */

export const REQUEST_TTL_MS = 2 * 60 * 1000
export const MAX_ACTIVE_DEVICES = 10

export const REQUEST_KINDS = ["enroll", "login", "sensitive"] as const
export type RequestKind = (typeof REQUEST_KINDS)[number]

export const LIMITS = {
  sub: 128,
  id: 128,
  installationId: 128,
  deviceName: 80,
  actionLabel: 100,
  contextDevice: 80,
  contextLocation: 80,
  contextIp: 45,
} as const

export type RequestChallenge = {
  number: string
  choices: [string, string, string]
}

/** Entier uniforme dans [min, max], par rejet (pas de biais modulo). */
export function randomIntInclusive(
  min: number,
  max: number,
  random: (buffer: Uint32Array) => Uint32Array = (buffer) =>
    crypto.getRandomValues(buffer),
): number {
  const span = max - min + 1
  const limit = Math.floor(0x1_0000_0000 / span) * span
  for (;;) {
    const [value] = random(new Uint32Array(1))
    if (value! < limit) return min + (value! % span)
  }
}

/**
 * Tire le nombre à 2 chiffres (10 à 99) et trois choix distincts, dont le
 * bon, dans un ordre mélangé. Le partenaire reçoit `number` ; l'app ne reçoit
 * que `choices`.
 */
export function drawChallenge(
  random?: (buffer: Uint32Array) => Uint32Array,
): RequestChallenge {
  const number = randomIntInclusive(10, 99, random)
  const decoys = new Set<number>()
  while (decoys.size < 2) {
    const candidate = randomIntInclusive(10, 99, random)
    if (candidate !== number) decoys.add(candidate)
  }
  const values = [number, ...decoys]
  // Fisher-Yates avec tirage uniforme.
  for (let index = values.length - 1; index > 0; index--) {
    const swap = randomIntInclusive(0, index, random)
    ;[values[index], values[swap]] = [values[swap]!, values[index]!]
  }
  return {
    number: String(number),
    choices: [String(values[0]), String(values[1]), String(values[2])] as [
      string,
      string,
      string,
    ],
  }
}

export type StoredRequestStatus =
  | "pending"
  | "approved"
  | "denied"
  | "wrong_number"
  | "cancelled"
  | "expired"

/**
 * Statut présenté : une demande `pending` dont l'échéance est passée est
 * `expired`, même si rien ne l'a encore écrit en base.
 */
export function effectiveStatus(
  row: { status: StoredRequestStatus; expiresAt: number },
  now: number,
): StoredRequestStatus {
  if (row.status === "pending" && row.expiresAt <= now) return "expired"
  return row.status
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string }

function plainObject(body: unknown): Record<string, unknown> | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null
  }
  return body as Record<string, unknown>
}

/** Refuse les clés hors liste blanche : une faute de frappe ne doit pas passer. */
function unknownKeyMessage(
  object: Record<string, unknown>,
  allowed: readonly string[],
): string | null {
  const unknown = Object.keys(object).find((key) => !allowed.includes(key))
  return unknown ? `Champ inconnu « ${unknown} ».` : null
}

/**
 * Chaîne obligatoire, rognée, de longueur 1..max. Renvoie null si invalide.
 */
function requiredText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > max) return null
  return trimmed
}

/** Chaîne facultative : absente ou vide => undefined ; trop longue => erreur. */
function optionalText(
  value: unknown,
  max: number,
): { ok: true; value: string | undefined } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: undefined }
  if (typeof value !== "string") return { ok: false }
  const trimmed = value.trim()
  if (trimmed.length > max) return { ok: false }
  return { ok: true, value: trimmed.length > 0 ? trimmed : undefined }
}

export type RequestContext = {
  device?: string
  ip?: string
  location?: string
}

export type CreateRequestInput = {
  sub: string
  kind: RequestKind
  actionLabel?: string
  context: RequestContext
}

export function parseCreateRequestBody(
  body: unknown,
): Parsed<CreateRequestInput> {
  const object = plainObject(body)
  if (!object) return { ok: false, message: "Corps JSON attendu." }
  const unknown = unknownKeyMessage(object, [
    "sub",
    "kind",
    "actionLabel",
    "context",
  ])
  if (unknown) return { ok: false, message: unknown }

  const sub = requiredText(object.sub, LIMITS.sub)
  if (!sub) return { ok: false, message: "« sub » est requis." }

  const kind = object.kind
  if (!REQUEST_KINDS.includes(kind as RequestKind)) {
    return { ok: false, message: "« kind » doit valoir enroll, login ou sensitive." }
  }

  const actionLabel = optionalText(object.actionLabel, LIMITS.actionLabel)
  if (!actionLabel.ok) {
    return { ok: false, message: `« actionLabel » : ${LIMITS.actionLabel} caractères au plus.` }
  }

  let context: RequestContext = {}
  if (object.context !== undefined && object.context !== null) {
    const raw = plainObject(object.context)
    if (!raw) return { ok: false, message: "« context » doit être un objet." }
    const extra = unknownKeyMessage(raw, ["device", "ip", "location"])
    if (extra) return { ok: false, message: extra }
    const device = optionalText(raw.device, LIMITS.contextDevice)
    const location = optionalText(raw.location, LIMITS.contextLocation)
    const ip = optionalText(raw.ip, LIMITS.contextIp)
    if (!device.ok || !location.ok || !ip.ok) {
      return { ok: false, message: "« context » : longueur de champ dépassée." }
    }
    context = {
      device: device.value,
      location: location.value,
      ip: ip.value,
    }
  }

  return {
    ok: true,
    value: {
      sub,
      kind: kind as RequestKind,
      actionLabel: actionLabel.value,
      context,
    },
  }
}

export function parseIdQuery(raw: string | null): Parsed<string> {
  const id = requiredText(raw ?? undefined, LIMITS.id)
  return id ? { ok: true, value: id } : { ok: false, message: "« id » est requis." }
}

export function parseIdBody(body: unknown): Parsed<string> {
  const object = plainObject(body)
  if (!object) return { ok: false, message: "Corps JSON attendu." }
  const unknown = unknownKeyMessage(object, ["id"])
  if (unknown) return { ok: false, message: unknown }
  const id = requiredText(object.id, LIMITS.id)
  return id ? { ok: true, value: id } : { ok: false, message: "« id » est requis." }
}

export function parseSubQuery(raw: string | null): Parsed<string> {
  const sub = requiredText(raw ?? undefined, LIMITS.sub)
  return sub ? { ok: true, value: sub } : { ok: false, message: "« sub » est requis." }
}

export function parseSubBody(body: unknown): Parsed<string> {
  const object = plainObject(body)
  if (!object) return { ok: false, message: "Corps JSON attendu." }
  const unknown = unknownKeyMessage(object, ["sub"])
  if (unknown) return { ok: false, message: unknown }
  const sub = requiredText(object.sub, LIMITS.sub)
  return sub ? { ok: true, value: sub } : { ok: false, message: "« sub » est requis." }
}

export function parseTotpBody(body: unknown): Parsed<{ sub: string; code: string }> {
  const object = plainObject(body)
  if (!object) return { ok: false, message: "Corps JSON attendu." }
  const unknown = unknownKeyMessage(object, ["sub", "code"])
  if (unknown) return { ok: false, message: unknown }
  const sub = requiredText(object.sub, LIMITS.sub)
  if (!sub) return { ok: false, message: "« sub » est requis." }
  if (typeof object.code !== "string" || !/^\d{6}$/.test(object.code)) {
    return { ok: false, message: "« code » doit comporter 6 chiffres." }
  }
  return { ok: true, value: { sub, code: object.code } }
}
