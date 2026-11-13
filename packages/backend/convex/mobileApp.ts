import { ConvexError, v } from "convex/values"

import {
  internalMutation,
  internalQuery,
  query,
  type QueryCtx,
} from "./_generated/server"

/**
 * Applications mobiles proposées sur l'accueil public (identite.ga).
 *
 * Android : l'APK de production est hébergé dans le stockage Convex, derrière
 * un lien qui ne change jamais — `GET <CONVEX_SITE_URL>/downloads/identite-android.apk`
 * redirige vers le dernier fichier publié (voir `convex/http.ts`).
 *
 * iPhone : lien de la bêta publique TestFlight, lu dans la variable Convex
 * `IOS_TESTFLIGHT_URL` (modifiable sans redéployer le site).
 *
 * Publication d'un APK (script `apps/mobile/scripts/publish-apk.sh`, clé
 * d'administration requise — fonctions internes) :
 *   1. `generateUploadUrl` → URL de dépôt du stockage Convex ;
 *   2. POST du fichier .apk sur cette URL → `storageId` ;
 *   3. `publish` → enregistre la version, qui devient celle du lien.
 */

/** Chemin public de la route stable (relatif à `CONVEX_SITE_URL`). */
export const ANDROID_APK_PATH = "/downloads/identite-android.apk"

/** Versions conservées : la courante et la précédente (retour arrière). */
const KEEP_BUILDS = 2

/** Un APK fait plusieurs dizaines de Mo : en dessous, l'envoi a échoué. */
const MIN_APK_BYTES = 1_000_000

async function latestBuild(ctx: QueryCtx) {
  return await ctx.db.query("mobileAppBuild").order("desc").first()
}

export const generateUploadUrl = internalMutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => await ctx.storage.generateUploadUrl(),
})

export const publish = internalMutation({
  args: {
    storageId: v.id("_storage"),
    version: v.string(),
    buildNumber: v.string(),
  },
  returns: v.object({ sizeBytes: v.number(), kept: v.number() }),
  handler: async (ctx, args) => {
    const file = await ctx.db.system.get("_storage", args.storageId)
    if (!file) throw new ConvexError("Fichier introuvable dans le stockage.")
    if (file.size < MIN_APK_BYTES)
      throw new ConvexError("Fichier trop petit pour être un APK.")

    await ctx.db.insert("mobileAppBuild", {
      storageId: args.storageId,
      version: args.version,
      buildNumber: args.buildNumber,
      sizeBytes: file.size,
      publishedAt: Date.now(),
    })

    const builds = await ctx.db.query("mobileAppBuild").order("desc").take(50)
    for (const old of builds.slice(KEEP_BUILDS)) {
      await ctx.storage.delete(old.storageId)
      await ctx.db.delete(old._id)
    }
    return { sizeBytes: file.size, kept: Math.min(builds.length, KEEP_BUILDS) }
  },
})

/** Dernier APK publié — lu par la route HTTP de téléchargement. */
export const latest = internalQuery({
  args: {},
  returns: v.union(
    v.object({
      storageId: v.id("_storage"),
      version: v.string(),
      buildNumber: v.string(),
    }),
    v.null(),
  ),
  handler: async (ctx) => {
    const build = await latestBuild(ctx)
    if (!build) return null
    return {
      storageId: build.storageId,
      version: build.version,
      buildNumber: build.buildNumber,
    }
  },
})

/**
 * Liens affichés par la section « Applications mobiles » de l'accueil.
 * `apk` vaut `null` tant qu'aucun APK n'est publié, `ios` tant que la bêta
 * publique n'est pas ouverte : la page affiche alors un message d'attente
 * plutôt qu'un lien mort.
 */
export const getLinks = query({
  args: {},
  returns: v.object({
    ios: v.union(v.string(), v.null()),
    apk: v.union(v.string(), v.null()),
    apkVersion: v.union(v.string(), v.null()),
    apkPublishedAt: v.union(v.number(), v.null()),
  }),
  handler: async (ctx) => {
    const build = await latestBuild(ctx)
    const siteUrl = process.env.CONVEX_SITE_URL
    const published = build && siteUrl ? build : null
    return {
      ios: process.env.IOS_TESTFLIGHT_URL?.trim() || null,
      apk: published ? `${siteUrl}${ANDROID_APK_PATH}` : null,
      apkVersion: published ? published.version : null,
      apkPublishedAt: published ? published.publishedAt : null,
    }
  },
})
