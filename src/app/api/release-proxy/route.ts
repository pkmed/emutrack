import { NextRequest } from 'next/server'

/**
 * Optional same-origin relay used ONLY as a fallback when a direct browser
 * fetch is blocked (e.g. CORS-restricted HTML parsing of self-hosted GitHub
 * pages, or restricted networks). When the app is deployed as a static PWA
 * (GitHub Pages) this route does not exist and the client silently keeps
 * using direct fetches, preserving the "no backend" deployment model.
 */

export const dynamic = 'force-dynamic'

const PRIVATE_HOST_RE =
  /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|\[?fc00|\[?fd)/i

export async function GET(req: NextRequest) {
  const target = req.nextUrl.searchParams.get('url')
  if (!target) {
    return new Response('Missing "url" query parameter.', { status: 400 })
  }

  let parsed: URL
  try {
    parsed = new URL(target)
  } catch {
    return new Response('Invalid URL.', { status: 400 })
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return new Response('Only http(s) URLs are allowed.', { status: 400 })
  }
  if (PRIVATE_HOST_RE.test(parsed.hostname)) {
    return new Response('Refusing to fetch private/local addresses.', { status: 403 })
  }

  const accept =
    req.nextUrl.searchParams.get('accept') ?? 'application/vnd.github+json'

  try {
    const upstream = await fetch(parsed.toString(), {
      headers: { Accept: accept, 'User-Agent': 'EmuTrack/1.0 (release tracker PWA)' },
      cache: 'no-store',
      redirect: 'follow',
    })
    const body = await upstream.text()
    return new Response(body, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('content-type') ?? 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    })
  } catch {
    return new Response('Upstream request failed.', { status: 502 })
  }
}
