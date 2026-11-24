import type { Jwk } from "better-auth/plugins/jwt"

/**
 * Clés de signature d'IDN (table `jwks` du composant Better Auth) — CH-820,
 * ADR 0002.
 *
 * Un seul algorithme, RS256 : @convex-dev/better-auth 0.12 l'impose au
 * fournisseur `customJwt` du plan de données Convex, et les deux instances du
 * plugin jwt (ID tokens OIDC, JWT Convex) partagent cette table et signent
 * avec la clé la plus récente. Toute clé créée par rotation est RSA 3072.
 */
export const SIGNING_KEY_PAIR_CONFIG = { alg: "RS256", modulusLength: 3072 } as const

type StoredJwk = Omit<Jwk, "createdAt" | "expiresAt"> & {
  createdAt: Date | number | string
  expiresAt?: Date | number | string | null
}

const toDate = (value: Date | number | string): Date =>
  value instanceof Date ? value : new Date(value)

/**
 * L'adaptateur Convex rend les dates en nombres ; le plugin jwt de Better
 * Auth trie les clés avec `createdAt.getTime()`. Sans cette normalisation,
 * dès qu'une deuxième clé existe, `/oauth2/token` lève une TypeError (500).
 */
export function normalizeJwk(row: StoredJwk): Jwk {
  const { createdAt, expiresAt, ...rest } = row
  return {
    ...rest,
    createdAt: toDate(createdAt),
    ...(expiresAt !== undefined && expiresAt !== null ? { expiresAt: toDate(expiresAt) } : {}),
  } as Jwk
}

type AdapterCtx = {
  context: { adapter: { findMany: (input: { model: string }) => Promise<unknown[]> } }
}

/** `adapter.getJwks` du plugin jwt explicite : toutes les clés, dates en `Date`. */
export async function readSigningKeys(ctx: AdapterCtx): Promise<Jwk[]> {
  const rows = (await ctx.context.adapter.findMany({ model: "jwks" })) as StoredJwk[]
  return rows.map(normalizeJwk)
}

/** Taille du module RSA d'une clé publique JWK, en bits (0 si illisible). */
export function rsaModulusBits(publicKey: string): number {
  try {
    const jwk = JSON.parse(publicKey) as { n?: unknown }
    if (typeof jwk.n !== "string") return 0
    const bytes = atob(jwk.n.replace(/-/g, "+").replace(/_/g, "/"))
    let leading = 0
    // Les zéros de tête éventuels ne comptent pas dans la taille du module.
    while (leading < bytes.length && bytes.charCodeAt(leading) === 0) leading++
    const first = bytes.charCodeAt(leading)
    return (bytes.length - leading - 1) * 8 + (first ? Math.floor(Math.log2(first)) + 1 : 0)
  } catch {
    return 0
  }
}
