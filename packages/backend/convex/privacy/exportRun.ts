import { ConvexError, v } from "convex/values"

import { internal } from "../_generated/api"
import type { Doc, Id } from "../_generated/dataModel"
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server"

/**
 * Export RGPD : la collecte reste une query (un seul instantané utilisateur),
 * appelée depuis l'action. Ne pas déplacer ses lectures dans une mutation.
 * Les petites archives sont finalisées atomiquement : blob + audit + email
 * asynchrone + purge. Les plus grandes conservent le stockage depuis l'action.
 */
const EXPORT_TTL_MS = 24 * 60 * 60 * 1000
// Borne applicative, pas un plafond Convex : laisse de la marge aux arguments
// et au runtime V8. Au-delà, on conserve le chemin action, sans tronquer le JSON.
const MAX_TRANSACTIONAL_EXPORT_BYTES = 512 * 1024
// Une valeur Convex ne peut contenir plus de 8192 éléments par tableau.
// Détecter le dépassement, jamais tronquer silencieusement un export.
const MAX_EXPORT_ROWS = 8192

type ExportPayload = {
  profile: Omit<Doc<"userProfile">, "pinHash"> | null
  kycRequests: Doc<"kycRequest">[]
  walletCards: Doc<"walletCard">[]
  iboite: {
    accounts: Doc<"iboiteAccount">[]
    letters: Doc<"iboiteLetter">[]
    messages: Doc<"iboiteMessage">[]
  }
  documents: Doc<"documentItem">[]
  cvs: Doc<"citizenCv">[]
  notifications: Doc<"notification">[]
  preferences: Doc<"userPreference">[]
}

async function readExportRows<T>(rows: Promise<T[]>): Promise<T[]> {
  const result = await rows
  if (result.length > MAX_EXPORT_ROWS) {
    throw new ConvexError({
      code: "EXPORT_COLLECTION_TOO_LARGE",
      message:
        "Le compte dépasse la taille d'un export automatique ; contactez privacy@identite.ga.",
    })
  }
  return result
}

const requestArgs = {
  userId: v.string(),
  email: v.string(),
  requestId: v.id("auditLog"),
}
type ExportRequest = {
  userId: string
  email: string
  requestId: Id<"auditLog">
}
type FinalizeResult =
  | { status: "ready"; storageId: Id<"_storage"> }
  | { status: "needs_action" }

export const runDataExport = internalAction({
  args: {
    userId: v.string(),
    email: v.string(),
    // Compatibilité avec les actions déjà planifiées avant cette migration.
    requestId: v.optional(v.id("auditLog")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const state: {
      requestId: Id<"auditLog">
      storageId: Id<"_storage"> | null
      generatedAt: number
    } = await ctx.runMutation(
      internal.privacy.exportRun.ensureExportRequest,
      args,
    )
    if (state.storageId) return null
    const request: ExportRequest = { ...args, requestId: state.requestId }

    const payload = await ctx.runQuery(
      internal.privacy.exportRun.collectExportPayload,
      { userId: args.userId },
    )
    const blob = new Blob(
      [
        JSON.stringify(
          {
            meta: {
              generatedAt: new Date(state.generatedAt).toISOString(),
              userId: args.userId,
              source: "identite.ga · IDN data export RGPD",
            },
            data: payload,
          },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    )

    if (blob.size <= MAX_TRANSACTIONAL_EXPORT_BYTES) {
      const result: FinalizeResult = await ctx.runMutation(
        internal.privacy.exportRun.finalizeExport,
        { ...request, bytes: await blob.arrayBuffer() },
      )
      if (result.status === "ready") return null
    }

    // La réservation lie l'archive collectée à la demande avant l'écriture
    // hors transaction. Un storageId seul n'autorise jamais son adoption.
    // _storage expose l'empreinte en base64 depuis convex 1.9.
    const sha256 = btoa(
      String.fromCharCode(
        ...new Uint8Array(
          await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
        ),
      ),
    )
    const alreadyStored: Id<"_storage"> | null = await ctx.runMutation(
      internal.privacy.exportRun.prepareLargeExport,
      { ...request, sha256, size: blob.size },
    )
    if (alreadyStored) return null

    const storageId = await ctx.storage.store(blob)
    // Filet de sécurité dès le stockage, même si l'adoption échoue ensuite.
    // La finalisation programme aussi sa propre purge dans sa transaction.
    try {
      await ctx.scheduler.runAfter(
        EXPORT_TTL_MS,
        internal.privacy.exportRun.purgeExportBlob,
        { storageId },
      )
    } catch (error) {
      // Aucune adoption n'a encore été tentée : ce blob est à nous et
      // peut être supprimé sans invalider un export publié par ailleurs.
      await ctx.storage.delete(storageId)
      throw error
    }
    const adopted: Id<"_storage"> = await ctx.runMutation(
      internal.privacy.exportRun.finalizeStoredExport,
      { ...request, storageId },
    )
    // Deux actions concurrentes peuvent avoir stocké le même export réservé.
    // Seul le gagnant est publié ; l'autre blob a aussi sa purge de secours.
    if (adopted !== storageId) await ctx.storage.delete(storageId)
    return null
  },
})

async function validateRequest(ctx: QueryCtx, args: ExportRequest) {
  const request = await ctx.db.get(args.requestId)
  if (
    !request ||
    request.actorId !== args.userId ||
    request.action !== "admin_action" ||
    request.targetType !== "user" ||
    request.targetId !== args.userId ||
    request.metadata?.kind !== "data_export_requested" ||
    (request.metadata.email !== undefined &&
      request.metadata.email !== args.email)
  ) {
    throw new ConvexError({
      code: "INVALID_EXPORT_REQUEST",
      message: "Demande d'export invalide.",
    })
  }
  return request
}

async function findExportAudit(
  ctx: QueryCtx,
  requestId: Id<"auditLog">,
  kind: string,
) {
  return await ctx.db
    .query("auditLog")
    .withIndex("by_target", (q) =>
      q.eq("targetType", "system").eq("targetId", `${kind}:${requestId}`),
    )
    .unique()
}

async function completedExport(
  ctx: QueryCtx,
  args: ExportRequest,
): Promise<Id<"_storage"> | null> {
  await validateRequest(ctx, args)
  const entry = await findExportAudit(ctx, args.requestId, "data_export_ready")
  if (!entry) return null
  const storageId =
    typeof entry.metadata?.storageId === "string"
      ? ctx.db.system.normalizeId("_storage", entry.metadata.storageId)
      : null
  if (!storageId)
    throw new ConvexError({
      code: "INVALID_EXPORT_STATE",
      message: "Trace d'export invalide.",
    })
  // Une reprise après expiration ne recrée pas le blob ni ne prolonge son TTL.
  return storageId
}

export const ensureExportRequest = internalMutation({
  args: {
    userId: v.string(),
    email: v.string(),
    requestId: v.optional(v.id("auditLog")),
  },
  returns: v.object({
    requestId: v.id("auditLog"),
    storageId: v.union(v.id("_storage"), v.null()),
    generatedAt: v.number(),
  }),
  handler: async (ctx, args) => {
    const requestId: Id<"auditLog"> =
      args.requestId ??
      (await ctx.runMutation(internal.audit.recordAudit, {
        actorId: args.userId,
        action: "admin_action",
        targetType: "user",
        targetId: args.userId,
        metadata: { kind: "data_export_requested", email: args.email },
      }))
    const request = await validateRequest(ctx, { ...args, requestId })
    return {
      requestId,
      storageId: await completedExport(ctx, { ...args, requestId }),
      generatedAt: request.createdAt,
    }
  },
})

async function publishExport(
  ctx: MutationCtx,
  args: ExportRequest,
  storageId: Id<"_storage">,
  expiresAt = Date.now() + EXPORT_TTL_MS,
) {
  const url = await ctx.storage.getUrl(storageId)
  if (!url) {
    throw new ConvexError({
      code: "EXPORT_URL_UNAVAILABLE",
      message: "Le lien de téléchargement de l'export est indisponible.",
    })
  }
  await ctx.scheduler.runAt(
    expiresAt,
    internal.privacy.exportRun.purgeExportBlob,
    { storageId },
  )
  await ctx.runMutation(internal.privacy.exportRun.sendExportEmail, {
    to: args.email,
    downloadUrl: url,
    storageId,
  })
  await ctx.runMutation(internal.audit.recordAudit, {
    actorId: args.userId,
    action: "admin_action",
    targetType: "system",
    targetId: `data_export_ready:${args.requestId}`,
    metadata: {
      kind: "data_export_ready",
      storageId,
      expiresAt,
      requestId: args.requestId,
    },
  })
}

export const finalizeExport = internalMutation({
  args: { ...requestArgs, bytes: v.bytes() },
  returns: v.union(
    v.object({ status: v.literal("ready"), storageId: v.id("_storage") }),
    v.object({ status: v.literal("needs_action") }),
  ),
  handler: async (ctx, args): Promise<FinalizeResult> => {
    if (args.bytes.byteLength > MAX_TRANSACTIONAL_EXPORT_BYTES) {
      throw new ConvexError({
        code: "EXPORT_TOO_LARGE",
        message: "Finalisation transactionnelle limitée à 512 Kio.",
      })
    }
    const existing = await completedExport(ctx, args)
    if (existing) return { status: "ready", storageId: existing }
    if (await findExportAudit(ctx, args.requestId, "data_export_prepared")) {
      throw new ConvexError({
        code: "EXPORT_SOURCE_CHANGED",
        message: "Une autre archive a déjà été réservée pour cette demande.",
      })
    }
    const metrics = await ctx.meta.getTransactionMetrics()
    // Les budgets effectifs viennent du serveur ; aucun plafond supposé.
    if (
      metrics.filesWritten.remaining < 1 ||
      metrics.fileWriteBytes.remaining < args.bytes.byteLength
    ) {
      return { status: "needs_action" }
    }
    const storageId = await ctx.storage.store(
      new Blob([args.bytes], { type: "application/json" }),
    )
    await publishExport(ctx, args, storageId)
    return { status: "ready", storageId }
  },
})

export const prepareLargeExport = internalMutation({
  args: { ...requestArgs, sha256: v.string(), size: v.number() },
  returns: v.union(v.id("_storage"), v.null()),
  handler: async (ctx, args) => {
    const existing = await completedExport(ctx, args)
    if (existing) return existing
    if (
      !/^[A-Za-z0-9+/]{43}=$/.test(args.sha256) ||
      !Number.isSafeInteger(args.size) ||
      args.size < 0
    ) {
      throw new ConvexError({
        code: "INVALID_EXPORT_SOURCE",
        message: "Archive d'export invalide.",
      })
    }
    const reservation = await findExportAudit(
      ctx,
      args.requestId,
      "data_export_prepared",
    )
    if (reservation) {
      if (
        reservation.metadata?.sha256 !== args.sha256 ||
        reservation.metadata?.size !== args.size
      ) {
        throw new ConvexError({
          code: "EXPORT_SOURCE_CHANGED",
          message: "L'archive réservée a changé ; demandez un nouvel export.",
        })
      }
      return null
    }
    await ctx.runMutation(internal.audit.recordAudit, {
      actorId: args.userId,
      action: "admin_action",
      targetType: "system",
      targetId: `data_export_prepared:${args.requestId}`,
      metadata: {
        kind: "data_export_prepared",
        sha256: args.sha256,
        size: args.size,
      },
    })
    return null
  },
})

export const finalizeStoredExport = internalMutation({
  args: { ...requestArgs, storageId: v.id("_storage") },
  returns: v.id("_storage"),
  handler: async (ctx, args) => {
    const existing = await completedExport(ctx, args)
    if (existing) return existing
    const reservation = await findExportAudit(
      ctx,
      args.requestId,
      "data_export_prepared",
    )
    // Vérification en métadonnées uniquement : aucun gros blob lu en mutation.
    const file = await ctx.db.system.get("_storage", args.storageId)
    if (
      !reservation ||
      !file ||
      file.contentType !== "application/json" ||
      file.sha256 !== reservation.metadata?.sha256 ||
      file.size !== reservation.metadata?.size
    ) {
      throw new ConvexError({
        code: "INVALID_EXPORT_SOURCE",
        message: "Ce fichier ne correspond pas à l'archive réservée.",
      })
    }
    const expiresAt = file._creationTime + EXPORT_TTL_MS
    if (expiresAt <= Date.now()) {
      throw new ConvexError({
        code: "EXPORT_SOURCE_EXPIRED",
        message: "L'archive réservée a expiré ; demandez un nouvel export.",
      })
    }
    await publishExport(ctx, args, args.storageId, expiresAt)
    return args.storageId
  },
})

export const collectExportPayload = internalQuery({
  args: { userId: v.string() },
  // Le type de retour reste précis sans v.any(). Les budgets DB usuels
  // (octets/documents) s'appliquent à cette query, hors finalisation mutation.
  handler: async (ctx, args): Promise<ExportPayload> => {
    const userId = args.userId

    const profile = await ctx.db
      .query("userProfile")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique()

    const kycRequests = await readExportRows(
      ctx.db
        .query("kycRequest")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .take(MAX_EXPORT_ROWS + 1),
    )

    const cards = await readExportRows(
      ctx.db
        .query("walletCard")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .take(MAX_EXPORT_ROWS + 1),
    )

    const accounts = await readExportRows(
      ctx.db
        .query("iboiteAccount")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .take(MAX_EXPORT_ROWS + 1),
    )

    const letters = await readExportRows(
      ctx.db
        .query("iboiteLetter")
        .withIndex("by_user_folder", (q) => q.eq("userId", userId))
        .take(MAX_EXPORT_ROWS + 1),
    )

    const messages = await readExportRows(
      ctx.db
        .query("iboiteMessage")
        .withIndex("by_user_folder", (q) => q.eq("userId", userId))
        .take(MAX_EXPORT_ROWS + 1),
    )

    const documents = await readExportRows(
      ctx.db
        .query("documentItem")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .take(MAX_EXPORT_ROWS + 1),
    )

    const cvs = await readExportRows(
      ctx.db
        .query("citizenCv")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .take(MAX_EXPORT_ROWS + 1),
    )

    const notifications = await ctx.db
      .query("notification")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .take(500)

    const preferences = await readExportRows(
      ctx.db
        .query("userPreference")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .take(MAX_EXPORT_ROWS + 1),
    )

    // L'empreinte du PIN ne quitte jamais le serveur : l'archive circule par
    // un lien non authentifié, et un PIN à 6 chiffres se retrouve hors ligne
    // en essayant le million de combinaisons contre son empreinte.
    const exportedProfile = profile
      ? (({ pinHash: _pinHash, ...rest }) => rest)(profile)
      : null

    return {
      profile: exportedProfile,
      kycRequests,
      walletCards: cards,
      iboite: { accounts, letters, messages },
      documents,
      cvs,
      notifications,
      preferences,
    }
  },
})

export const sendExportEmail = internalMutation({
  args: {
    to: v.string(),
    downloadUrl: v.string(),
    storageId: v.id("_storage"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const linkLine = args.downloadUrl
      ? `Lien de téléchargement (valable 24h) :\n${args.downloadUrl}`
      : "Lien indisponible — contactez privacy@identite.ga pour récupérer votre archive."
    await ctx.scheduler.runAfter(0, internal.email.dispatch.sendGeneric, {
      to: args.to,
      subject: "Votre archive de données IDN",
      title: "Votre export de données est prêt",
      body:
        "Conformément au RGPD et à la loi gabonaise 001/2011, voici l'archive JSON de toutes les données associées à votre compte Identité Numérique.\n\n" +
        linkLine +
        "\n\nL'archive contient votre profil, vos demandes KYC, vos cartes iCarte, vos courriers et messages iBoîte, vos documents iDoc, vos CV et vos préférences. Les blobs (photos, pièces jointes) ne sont pas inclus dans ce premier export — contactez privacy@identite.ga si vous en avez besoin.\n\nSi vous n'êtes pas à l'origine de cette demande, contactez immédiatement le 1407.",
      recipientName: null,
    })
    return null
  },
})

export const purgeExportBlob = internalMutation({
  args: { storageId: v.id("_storage") },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (await ctx.db.system.get("_storage", args.storageId)) {
      await ctx.storage.delete(args.storageId)
    }
    return null
  },
})
