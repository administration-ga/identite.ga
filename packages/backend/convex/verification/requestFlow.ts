import { ConvexError } from "convex/values";

import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { rateLimiter } from "../rateLimiter";
import type { KYC_DOCUMENT_TYPES } from "../schema";
import { documentaryLoa } from "./documentProof";
import {
  isKycResumable,
  isLevel3Active,
  planRequiresDocumentType,
  planVerificationRequest,
  type DocumentTrackStatus,
  type TargetLoa,
  type VerificationRequestPlan,
} from "./requestPolicy";

/**
 * Exécution du parcours de vérification unifié.
 *
 * Isolée ici plutôt que dans le corps d'une mutation pour n'avoir QU'UNE
 * implémentation : `verification.request` (entrée nominale) et l'alias de
 * compatibilité `level3.start` la partagent. Deux copies auraient divergé au
 * premier ajustement de doctrine, et c'est précisément la doctrine — pas de
 * eidas3 sans preuve documentaire — qu'on ne peut pas laisser diverger.
 */

export type DocumentType = (typeof KYC_DOCUMENT_TYPES)[number];

export type OpenVerificationResult = {
  targetLoa: TargetLoa;
  kycRequestId?: Id<"kycRequest">;
  verificationId?: Id<"level3Verification">;
};

/** Vérification Niveau 3 encore en cours, s'il en existe une. */
export async function activeLevel3Row(
  // `DatabaseWriter` étend `DatabaseReader` : un ctx de mutation satisfait
  // cette signature, ce qui évite d'écrire deux fois la même lecture.
  ctx: { db: QueryCtx["db"] },
  userId: string,
): Promise<Doc<"level3Verification"> | null> {
  const recent = await ctx.db
    .query("level3Verification")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .order("desc")
    .take(10);
  return recent.find((row) => isLevel3Active(row.status)) ?? null;
}

/** Dernière demande KYC du citoyen, quel que soit son statut. */
export async function latestKycRow(
  ctx: { db: QueryCtx["db"] },
  userId: string,
): Promise<Doc<"kycRequest"> | null> {
  return await ctx.db
    .query("kycRequest")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .order("desc")
    .first();
}

/**
 * Ouvre une demande KYC — même forme que `kyc.initialize`. La collecte reste
 * pilotée par les mutations `kyc.*` (`setDocumentImage`, `setSelfie`,
 * `submit`), inchangées.
 */
async function openKycRequest(
  ctx: MutationCtx,
  userId: string,
  documentType: DocumentType,
): Promise<Id<"kycRequest">> {
  const now = Date.now();
  return await ctx.db.insert("kycRequest", {
    userId,
    documentType,
    documentImages: {},
    status: "pending",
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Ouvre ou reprend la vérification au niveau visé.
 *
 * Idempotente : rappelée avec la même cible, elle REPREND la demande en cours
 * au lieu d'en ouvrir une seconde. Le front peut donc l'appeler sans état,
 * y compris après un rechargement de page.
 */
export async function openVerificationRequest(
  ctx: MutationCtx,
  input: {
    userId: string;
    targetLoa: TargetLoa;
    documentType?: DocumentType;
  },
): Promise<OpenVerificationResult> {
  const profile = await ctx.db
    .query("userProfile")
    .withIndex("by_userId", (q) => q.eq("userId", input.userId))
    .unique();
  if (!profile) {
    throw new ConvexError({
      code: "PROFILE_REQUIRED",
      message: "Complétez votre profil avant de demander une vérification.",
    });
  }

  const kyc = await latestKycRow(ctx, input.userId);
  const level3 = await activeLevel3Row(ctx, input.userId);

  // Le niveau DÉTENU décide de « déjà vérifié » ; le niveau de PREUVE
  // décide de la piste documentaire. Ils ne diffèrent que pour un Niveau 2
  // attesté seulement par un partenaire, qui passe alors par les pièces comme
  // un Niveau 1 (cf. `documentProof.ts`, ADR 0003).
  const proofLoa = await documentaryLoa(ctx, input.userId, profile.loa);
  // Au journal, le niveau détenu n'apparaît que s'il diffère du niveau de
  // preuve (Niveau 2 attesté sans pièce examinée).
  const heldLoaIfDifferent =
    proofLoa !== profile.loa ? { heldLoa: profile.loa } : {};
  const plan: VerificationRequestPlan =
    profile.loa >= input.targetLoa
      ? { kind: "already_verified" }
      : planVerificationRequest({
          targetLoa: input.targetLoa,
          currentLoa: proofLoa,
          activeKyc: kyc ? { status: kyc.status as DocumentTrackStatus } : null,
          hasActiveLevel3: level3 !== null,
        });

  if (plan.kind === "already_verified") {
    throw new ConvexError({
      code: "ALREADY_VERIFIED",
      message: `Votre identité est déjà vérifiée au Niveau ${input.targetLoa}.`,
    });
  }
  if (planRequiresDocumentType(plan) && !input.documentType) {
    throw new ConvexError({
      code: "DOCUMENT_TYPE_REQUIRED",
      message: "Choisissez le type de pièce d'identité à présenter.",
    });
  }

  // ---- Niveau 2 seul ---------------------------------------------------
  if (plan.kind === "resume_kyc") {
    return { targetLoa: input.targetLoa, kycRequestId: kyc!._id };
  }
  if (plan.kind === "open_kyc") {
    await rateLimiter.limit(ctx, "kycSubmit", {
      key: input.userId,
      throws: true,
    });
    const kycRequestId = await openKycRequest(
      ctx,
      input.userId,
      input.documentType!,
    );
    return { targetLoa: input.targetLoa, kycRequestId };
  }

  // ---- Niveau 3 (piste documentaire jointe si le Niveau 2 manque) ------
  const now = Date.now();
  let kycRequestId: Id<"kycRequest"> | undefined;

  if (plan.openDocumentTrack) {
    await rateLimiter.limit(ctx, "kycSubmit", {
      key: input.userId,
      throws: true,
    });
    kycRequestId = await openKycRequest(
      ctx,
      input.userId,
      input.documentType!,
    );
  } else {
    // Piste déjà rattachée, ou demande KYC reprenable à rattacher.
    kycRequestId =
      level3?.kycRequestId ??
      (kyc && isKycResumable(kyc.status as DocumentTrackStatus)
        ? kyc._id
        : undefined);
  }

  if (plan.kind === "resume_level3") {
    // Rattrape une vérification restée sans piste documentaire : demande
    // ouverte avant la fusion des parcours, ou pièces rejetées depuis.
    if (kycRequestId && level3!.kycRequestId !== kycRequestId) {
      await ctx.db.patch(level3!._id, { kycRequestId, updatedAt: now });
      await ctx.runMutation(internal.audit.recordAudit, {
        actorId: input.userId,
        action: "level3_document_track_opened",
        targetType: "kyc",
        targetId: level3!._id,
        metadata: { kycRequestId, entryLoa: proofLoa, ...heldLoaIfDifferent },
      });
    }
    return {
      targetLoa: input.targetLoa,
      verificationId: level3!._id,
      kycRequestId,
    };
  }

  // `entryLoa` porte le niveau de PREUVE : tout consommateur qui saute l'étape
  // des pièces quand `entryLoa >= 2` (file partenaire `partner/verifications.ts`,
  // agenda contrôleur) la garde ainsi pour un Niveau 2 attesté seulement.
  // Identique au niveau détenu pour tout compte sans attestation.
  const verificationId = await ctx.db.insert("level3Verification", {
    userId: input.userId,
    status: "waiting_controller",
    roomName: "pending",
    kycRequestId,
    entryLoa: proofLoa,
    requestedAt: now,
    updatedAt: now,
  });
  await ctx.db.patch(verificationId, { roomName: `idn-l3-${verificationId}` });
  await ctx.runMutation(internal.audit.recordAudit, {
    actorId: input.userId,
    action: "level3_requested",
    targetType: "kyc",
    targetId: verificationId,
    metadata: {
      targetLoa: 3,
      entryLoa: proofLoa,
      method: "video_manual_review",
      ...heldLoaIfDifferent,
    },
  });
  if (kycRequestId && plan.openDocumentTrack) {
    await ctx.runMutation(internal.audit.recordAudit, {
      actorId: input.userId,
      action: "level3_document_track_opened",
      targetType: "kyc",
      targetId: verificationId,
      metadata: { kycRequestId, entryLoa: proofLoa, ...heldLoaIfDifferent },
    });
  }
  return { targetLoa: input.targetLoa, verificationId, kycRequestId };
}
