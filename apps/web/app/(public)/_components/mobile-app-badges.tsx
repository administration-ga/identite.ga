"use client"

import { useEffect, useState } from "react"
import { useConvex } from "convex/react"
import { api } from "@repo/backend/convex/_generated/api"
import {
  AppStoreBadge,
  GooglePlayBadge,
} from "@repo/ui/components/store-badges"
import { mobileApps } from "../_content/fr"

export function MobileAppBadges({ className = "" }: { className?: string }) {
  const convex = useConvex()
  const [links, setLinks] = useState({
    ios: mobileApps.iosUrl as string | null,
    apk: mobileApps.androidUrl as string | null,
  })

  useEffect(() => {
    let active = true
    convex.query(api.mobileApp.getLinks, {}).then(
      (result) => {
        if (active) setLinks(result)
      },
      () => {
        /* Keep the published links available if the query fails. */
      },
    )
    return () => {
      active = false
    }
  }, [convex])

  return (
    <div
      aria-label="Télécharger l’application mobile"
      className={`flex flex-wrap items-center gap-3 ${className}`}
    >
      {links.ios && (
        <a
          href={links.ios}
          aria-label="Télécharger sur l’App Store — bêta TestFlight"
          className="inline-flex rounded-lg transition-opacity hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
        >
          <AppStoreBadge height={44} />
        </a>
      )}
      {links.apk && (
        <a
          href="/downloads/android"
          aria-label="Télécharger l’application Android (APK)"
          className="inline-flex rounded-lg transition-opacity hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
        >
          <GooglePlayBadge height={44} />
        </a>
      )}
    </div>
  )
}
