// Stream directly from storage: the APK is never buffered in server memory.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 800

async function download(request: Request) {
  const release = await fetch(
    `https://site.identite.ga/downloads/identite-android.apk?t=${Date.now()}`,
    {
      redirect: "manual",
      cache: "no-store",
      signal: request.signal,
    },
  )
  if (release.status === 404)
    return new Response("Aucun APK publié.", { status: 404 })
  const location = release.headers.get("location")
  const version = release.headers
    .get("x-app-version")
    ?.match(
      /^([A-Za-z0-9][A-Za-z0-9.+_-]{0,47}) \(([A-Za-z0-9][A-Za-z0-9._-]{0,31})\)$/,
    )
  if (
    release.status !== 302 ||
    !location?.startsWith("https://api.identite.ga/api/storage/") ||
    !version
  ) {
    return new Response("Téléchargement momentanément indisponible.", {
      status: 502,
    })
  }
  const headers = new Headers()
  const range = request.headers.get("range")
  if (range) headers.set("Range", range)
  const file = await fetch(location, {
    method: request.method === "HEAD" ? "HEAD" : "GET",
    headers,
    redirect: "error",
    cache: "no-store",
    signal: request.signal,
  })
  if (!file.ok) return new Response(null, { status: file.status })
  const responseHeaders = new Headers({
    "Content-Type": "application/vnd.android.package-archive",
    "Content-Disposition": `attachment; filename="identite-ga-${version[1]}-build-${version[2]}.apk"`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  })
  for (const header of ["accept-ranges", "content-range", "etag"]) {
    const value = file.headers.get(header)
    if (value) responseHeaders.set(header, value)
  }
  if (request.method === "HEAD" && file.headers.has("content-length")) {
    responseHeaders.set("Content-Length", file.headers.get("content-length")!)
  }
  return new Response(file.body, {
    status: file.status,
    headers: responseHeaders,
  })
}

export const GET = download
export const HEAD = download
