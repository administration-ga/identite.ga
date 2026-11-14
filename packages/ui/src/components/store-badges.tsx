/** App Store and Google Play badges reused from Gabon Diplomatie. */

export function AppStoreBadge({ height = 50 }: { height?: number }) {
  return (
    <svg
      role="img"
      aria-label="Télécharger sur l'App Store"
      viewBox="0 0 168 50"
      width="168"
      height="50"
      style={{ height, width: "auto" }}
    >
      <rect width="168" height="50" rx="8" fill="#000000" />
      <rect
        x="0.5"
        y="0.5"
        width="167"
        height="49"
        rx="7.5"
        fill="none"
        stroke="#A6A6A6"
      />
      {/* Apple logo */}
      <g fill="#FFFFFF">
        <path d="M32.6 25.6c0-3.3 2.7-4.9 2.8-5-1.5-2.3-3.9-2.6-4.8-2.6-2-.2-4 1.2-5 1.2-1.1 0-2.7-1.2-4.4-1.1-2.3 0-4.4 1.3-5.6 3.4-2.4 4.2-.6 10.4 1.7 13.8 1.1 1.7 2.5 3.5 4.3 3.5 1.7-.1 2.4-1.1 4.5-1.1 2.1 0 2.7 1.1 4.5 1.1 1.9 0 3.1-1.7 4.2-3.4 1.3-1.9 1.9-3.8 1.9-3.9-.1 0-3.6-1.4-3.6-5.5z" />
        <path d="M29.2 15.8c.9-1.1 1.6-2.7 1.4-4.2-1.4.1-3.1 1-4.1 2.1-.9 1-1.7 2.6-1.5 4.1 1.5.1 3.1-.8 4.2-2z" />
      </g>
      {/* Text */}
      <text
        x="46"
        y="20.5"
        fontFamily="Helvetica Neue, Arial, sans-serif"
        fontSize="9"
        fill="#FFFFFF"
      >
        Download on the
      </text>
      <text
        x="45.5"
        y="36"
        fontFamily="Helvetica Neue, Arial, sans-serif"
        fontSize="18"
        fontWeight="600"
        fill="#FFFFFF"
      >
        App Store
      </text>
    </svg>
  )
}

export function GooglePlayBadge({ height = 50 }: { height?: number }) {
  return (
    <svg
      role="img"
      aria-label="Disponible sur Google Play"
      viewBox="0 0 168 50"
      width="168"
      height="50"
      style={{ height, width: "auto" }}
    >
      <rect width="168" height="50" rx="8" fill="#000000" />
      <rect
        x="0.5"
        y="0.5"
        width="167"
        height="49"
        rx="7.5"
        fill="none"
        stroke="#A6A6A6"
      />
      {/* Play triangle — 4 facettes officielles */}
      <g transform="translate(14, 10)">
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
      {/* Text */}
      <text
        x="46"
        y="20.5"
        fontFamily="Helvetica Neue, Arial, sans-serif"
        fontSize="8.5"
        letterSpacing="0.5"
        fill="#FFFFFF"
      >
        GET IT ON
      </text>
      <text
        x="45.5"
        y="36"
        fontFamily="Helvetica Neue, Arial, sans-serif"
        fontSize="17"
        fontWeight="500"
        fill="#FFFFFF"
      >
        Google Play
      </text>
    </svg>
  )
}
