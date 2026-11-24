import type { ReactNode } from "react"

function StoreBadge({
  height,
  icon,
  label,
  store,
}: {
  height: number
  icon: ReactNode
  label: string
  store: string
}) {
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-lg border border-[#A6A6A6] bg-black text-white"
      style={{
        height,
        width: height * 3.36,
        paddingInline: height * 0.2,
        gap: height * 0.12,
      }}
    >
      {icon}
      <span
        className="flex min-w-0 flex-col text-left"
        style={{ fontFamily: "Helvetica Neue, Arial, sans-serif" }}
      >
        <span
          className="whitespace-nowrap leading-tight"
          style={{ fontSize: height * 0.18 }}
        >
          {label}
        </span>
        <span
          translate="no"
          className="whitespace-nowrap font-semibold leading-tight"
          style={{ fontSize: height * 0.34 }}
        >
          {store}
        </span>
      </span>
    </span>
  )
}

export function AppStoreBadge({ height = 50 }: { height?: number }) {
  return (
    <StoreBadge
      height={height}
      label="Télécharger sur"
      store="App Store"
      icon={
        <svg
          aria-hidden="true"
          viewBox="10 9 30 32"
          className="shrink-0"
          style={{ height: height * 0.64, width: height * 0.6 }}
        >
          <g fill="#FFFFFF">
            <path d="M32.6 25.6c0-3.3 2.7-4.9 2.8-5-1.5-2.3-3.9-2.6-4.8-2.6-2-.2-4 1.2-5 1.2-1.1 0-2.7-1.2-4.4-1.1-2.3 0-4.4 1.3-5.6 3.4-2.4 4.2-.6 10.4 1.7 13.8 1.1 1.7 2.5 3.5 4.3 3.5 1.7-.1 2.4-1.1 4.5-1.1 2.1 0 2.7 1.1 4.5 1.1 1.9 0 3.1-1.7 4.2-3.4 1.3-1.9 1.9-3.8 1.9-3.9-.1 0-3.6-1.4-3.6-5.5z" />
            <path d="M29.2 15.8c.9-1.1 1.6-2.7 1.4-4.2-1.4.1-3.1 1-4.1 2.1-.9 1-1.7 2.6-1.5 4.1 1.5.1 3.1-.8 4.2-2z" />
          </g>
        </svg>
      }
    />
  )
}

export function GooglePlayBadge({ height = 50 }: { height?: number }) {
  return (
    <StoreBadge
      height={height}
      label="Disponible sur"
      store="Google Play"
      icon={
        <svg
          aria-hidden="true"
          viewBox="0 0 30 32"
          className="shrink-0"
          style={{ height: height * 0.64, width: height * 0.6 }}
        >
          <g transform="translate(2, 1)">
            <path
              d="M0.4 1.1C0.1 1.4 0 1.9 0 2.5v25c0 .6.1 1.1.4 1.4l.1.1L15 14.5v-.3L.5 1z"
              fill="#00D3FF"
            />
            <path
              d="M19.8 19.3 15 14.5v-.3l4.8-4.8.1.1 5.7 3.2c1.6.9 1.6 2.4 0 3.3l-5.8 3.3z"
              fill="#FFCF23"
            />
            <path
              d="M19.9 19.2 15 14.3 0.4 28.9c.5.6 1.4.6 2.4.1l17.1-9.8"
              fill="#FF3D5D"
            />
            <path
              d="M19.9 9.5 2.8.1C1.8-.4.9-.4.4.2L15 14.3l4.9-4.8z"
              fill="#00E074"
            />
          </g>
        </svg>
      }
    />
  )
}
