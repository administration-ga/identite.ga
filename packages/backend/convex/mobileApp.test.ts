/// <reference types="vite/client" />
import { convexTest } from "convex-test"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { api, internal } from "./_generated/api"
import { ANDROID_APK_PATH } from "./mobileApp"
import schema from "./schema"

// Cf. kyc/mutations.test.ts pour l'explication du glob root-relative.
const modules = import.meta.glob("/convex/**/*.ts")
const setup = () => convexTest(schema, modules)

const SITE_URL = "https://site.example.ga"

beforeEach(() => {
  vi.stubEnv("CONVEX_SITE_URL", SITE_URL)
})
afterEach(() => vi.unstubAllEnvs())

/** Faux APK de 2 Mo : le contrôle de taille refuse les fichiers minuscules. */
const fakeApk = () => new Blob([new Uint8Array(2_000_000)])

async function publish(t: ReturnType<typeof setup>, buildNumber: string) {
  const storageId = await t.run((ctx) => ctx.storage.store(fakeApk()))
  await t.mutation(internal.mobileApp.publish, {
    storageId,
    version: "1.1.0",
    buildNumber,
  })
  return storageId
}

describe("APK Android hébergé derrière un lien stable", () => {
  // La page d'accueil ne doit jamais proposer un lien mort : sans APK publié
  // ni bêta ouverte, elle reçoit `null` et affiche un message d'attente.
  test("n'annonce aucun lien tant que rien n'est publié", async () => {
    const t = setup()
    expect(await t.query(api.mobileApp.getLinks, {})).toEqual({
      ios: null,
      apk: null,
      apkVersion: null,
      apkPublishedAt: null,
    })
  })

  // Le lien imprimé ou partagé ne doit pas changer d'une version à l'autre.
  test("donne le même lien stable à chaque publication", async () => {
    const t = setup()
    await publish(t, "18")
    const first = await t.query(api.mobileApp.getLinks, {})
    await publish(t, "19")
    const second = await t.query(api.mobileApp.getLinks, {})

    expect(first.apk).toBe(`${SITE_URL}${ANDROID_APK_PATH}`)
    expect(second.apk).toBe(first.apk)
    expect(second.apkVersion).toBe("1.1.0")
    expect(second.apkPublishedAt).toBeTypeOf("number")
  })

  test("expose le lien TestFlight de la bêta publique quand il est configuré", async () => {
    vi.stubEnv("IOS_TESTFLIGHT_URL", " https://testflight.apple.com/join/abc ")
    const t = setup()
    const links = await t.query(api.mobileApp.getLinks, {})
    expect(links.ios).toBe("https://testflight.apple.com/join/abc")
  })

  // Le stockage du serveur est limité : seules la version courante et la
  // précédente (retour arrière) sont gardées, fichiers compris.
  test("sert la dernière version et supprime les fichiers au-delà de deux", async () => {
    const t = setup()
    const first = await publish(t, "18")
    await publish(t, "19")
    const third = await publish(t, "20")

    const latest = await t.query(internal.mobileApp.latest, {})
    expect(latest?.buildNumber).toBe("20")
    expect(latest?.storageId).toBe(third)

    const remaining = await t.run(async (ctx) => ({
      rows: await ctx.db.query("mobileAppBuild").take(10),
      firstFile: await ctx.db.system.get("_storage", first),
    }))
    expect(remaining.rows.map((row) => row.buildNumber).sort()).toEqual([
      "19",
      "20",
    ])
    expect(remaining.firstFile).toBeNull()
  })

  // Un envoi raté (page d'erreur, fichier vide) ne doit pas remplacer l'APK
  // que les citoyens téléchargent.
  test("refuse un fichier trop petit pour être un APK", async () => {
    const t = setup()
    await publish(t, "18")
    const storageId = await t.run((ctx) =>
      ctx.storage.store(new Blob(["<html>erreur</html>"])),
    )
    await expect(
      t.mutation(internal.mobileApp.publish, {
        storageId,
        version: "1.1.0",
        buildNumber: "19",
      }),
    ).rejects.toThrow("trop petit")

    const latest = await t.query(internal.mobileApp.latest, {})
    expect(latest?.buildNumber).toBe("18")
  })

  test("la route stable répond 404 sans APK, puis redirige sans cache", async () => {
    const t = setup()
    const missing = await t.fetch(ANDROID_APK_PATH, { method: "GET" })
    expect(missing.status).toBe(404)

    await publish(t, "18")
    const found = await t.fetch(ANDROID_APK_PATH, {
      method: "GET",
      redirect: "manual",
    })
    expect(found.status).toBe(302)
    expect(found.headers.get("Location")).toBeTruthy()
    expect(found.headers.get("Cache-Control")).toBe("no-store")
    expect(found.headers.get("X-App-Version")).toBe("1.1.0 (18)")
  })
})
