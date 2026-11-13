"use client"

import { useEffect, useState, type ReactNode } from "react"
import { useConvex } from "convex/react"
import type { FunctionReturnType } from "convex/server"
import {
  AppleIcon,
  DownloadIcon,
  ExternalLinkIcon,
  SmartphoneIcon,
} from "lucide-react"

import { api } from "@repo/backend/convex/_generated/api"
import { Button } from "@repo/ui/components/button"
import { Card, CardContent } from "@repo/ui/components/card"

import { mobileApps } from "../_content/fr"

type Links = FunctionReturnType<typeof api.mobileApp.getLinks>

function formatDate(timestamp: number) {
  return new Date(timestamp).toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
  })
}

function PlatformCard({
  icon,
  name,
  description,
  children,
}: {
  icon: ReactNode
  name: string
  description: string
  children: ReactNode
}) {
  return (
    <Card className="h-full">
      <CardContent className="flex h-full flex-col items-start gap-3 px-5">
        <span
          className="flex size-10 items-center justify-center rounded-[9px] bg-secondary text-idn-green dark:text-idn-green-on-dark"
          aria-hidden="true"
        >
          {icon}
        </span>
        <h3 className="text-base font-semibold text-foreground">{name}</h3>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          {description}
        </p>
        {/* Hauteur réservée : les liens arrivent après le chargement. */}
        <div className="mt-auto flex min-h-12 w-full flex-col items-start justify-end gap-2 pt-2">
          {children}
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * Section « Applications mobiles » de l'accueil public. Les liens viennent de
 * Convex (`mobileApp.getLinks`) : l'APK Android publié derrière un lien
 * stable, et la bêta publique TestFlight pour iPhone. Sans lien disponible,
 * la carte affiche un message d'attente plutôt qu'un lien mort.
 *
 * Lecture ponctuelle plutôt que `useQuery` : si la fonction n'est pas encore
 * déployée ou si Convex est injoignable, `useQuery` ferait tomber toute la
 * page d'accueil. Ici l'échec se limite au message d'attente.
 */
export function MobileAppsSection() {
  const convex = useConvex()
  // undefined : chargement · null : lecture impossible.
  const [links, setLinks] = useState<Links | null | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    convex.query(api.mobileApp.getLinks, {}).then(
      (result) => {
        if (!cancelled) setLinks(result)
      },
      () => {
        if (!cancelled) setLinks(null)
      },
    )
    return () => {
      cancelled = true
    }
  }, [convex])
  const { android, ios } = mobileApps

  return (
    <section
      id="telecharger"
      aria-labelledby="mobile-apps-title"
      className="scroll-mt-20 border-t border-border"
    >
      <div className="mx-auto w-full max-w-[1180px] px-6 py-13 md:px-7">
        <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          {mobileApps.eyebrow}
        </p>
        <h2
          id="mobile-apps-title"
          className="mt-3 text-2xl font-semibold tracking-[-0.01em] text-foreground sm:text-3xl"
        >
          {mobileApps.title}
        </h2>
        <p className="mt-3 max-w-[560px] text-sm leading-relaxed text-muted-foreground sm:text-base">
          {mobileApps.sub}
        </p>

        <ul className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <li>
            <PlatformCard
              icon={<SmartphoneIcon className="size-5" />}
              name={android.name}
              description={android.description}
            >
              {links?.apk ? (
                <>
                  {links.apkVersion && links.apkPublishedAt ? (
                    <p className="text-xs text-muted-foreground">
                      {android.version} {links.apkVersion} ·{" "}
                      {android.publishedOn} {formatDate(links.apkPublishedAt)}
                    </p>
                  ) : null}
                  <Button asChild size="lg" className="w-full sm:w-auto">
                    <a href={links.apk}>
                      <DownloadIcon aria-hidden="true" />
                      {android.cta}
                    </a>
                  </Button>
                </>
              ) : links !== undefined ? (
                <p className="text-[13px] text-muted-foreground">
                  {android.unavailable}
                </p>
              ) : null}
            </PlatformCard>
          </li>
          <li>
            <PlatformCard
              icon={<AppleIcon className="size-5" />}
              name={ios.name}
              description={ios.description}
            >
              {links?.ios ? (
                <Button
                  asChild
                  variant="outline"
                  size="lg"
                  className="w-full sm:w-auto"
                >
                  <a href={links.ios}>
                    <ExternalLinkIcon aria-hidden="true" />
                    {ios.cta}
                  </a>
                </Button>
              ) : links !== undefined ? (
                <p className="text-[13px] text-muted-foreground">
                  {ios.unavailable}
                </p>
              ) : null}
            </PlatformCard>
          </li>
        </ul>
      </div>
    </section>
  )
}
