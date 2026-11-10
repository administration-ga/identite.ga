/**
 * Les fetch OAuth attendent du JSON. Certains rejets Better Auth utilisent
 * pourtant un 302 : le navigateur ne doit pas suivre ce retour comme un fetch
 * vers le client OAuth (HTML ou CORS) avant que le formulaire puisse naviguer.
 */
export function getFetchRedirectUrl({
  requestMode,
  responseStatus,
  location,
  upstreamUrl,
}: {
  requestMode: string | null
  responseStatus: number
  location: string | null
  upstreamUrl: string
}): string | null {
  if (
    requestMode !== "cors" ||
    ![301, 302, 303, 307, 308].includes(responseStatus) ||
    !location
  )
    return null

  try {
    const url = new URL(location, upstreamUrl)
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null
  } catch {
    return null
  }
}
