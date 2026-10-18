/**
 * Release retrieval logic, fully decoupled from the UI.
 *
 * Two retrieval methods are supported:
 *  1. GitHub Releases API (github.com, self-hosted GitHub Enterprise at
 *     /api/v3, or Forgejo/Gitea servers at /api/v1 — Forgejo and Gitea return
 *     GitHub-shaped release objects, so the same mapping works for either)
 *  2. Best-effort HTML parsing of the releases page (for self-hosted instances
 *     with permissive CORS; github.com does not allow cross-origin HTML fetches)
 *
 * The API method is always tried first because it is more reliable. If the API
 * fails, the HTML parser runs as a fallback. This module runs in the browser;
 * DOMParser is only used on the HTML path.
 *
 * Note on CORS: a pure client-side app can only read a server's responses if
 * that server sends Access-Control-Allow-Origin headers. Servers without CORS
 * remain unreachable from static deployments (there is deliberately no
 * backend/proxy on GitHub Pages); the optional same-origin proxy route only
 * exists in server-hosted deployments.
 */
import type { AssetInfo, ReleaseInfo } from './types'

export class SourceError extends Error {}

export interface ParsedRepoUrl {
  host: string
  origin: string
  owner: string
  repo: string
  /** Human-facing releases page: https://host/owner/repo/releases */
  releasesUrl: string
  /** REST API root: https://api.github.com or https://host/api/v3 */
  apiBase: string
  isGithubCom: boolean
}

const OWNER_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * Accepts URLs like:
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo/releases
 *   https://github.com/owner/repo/releases/tag/v1.2.0
 *   https://ghe.example.com/owner/repo/releases
 */
export function parseRepoUrl(rawUrl: string): ParsedRepoUrl | null {
  const trimmed = rawUrl.trim()
  if (!trimmed) return null
  let u: URL
  try {
    u = new URL(trimmed)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null

  const parts = u.pathname.split('/').filter(Boolean)
  if (parts.length < 2) return null
  const [owner, repoRaw] = parts
  const repo = repoRaw.replace(/\.git$/i, '')
  if (!OWNER_REPO_RE.test(owner) || !OWNER_REPO_RE.test(repo)) return null

  const isGithubCom = u.hostname === 'github.com' || u.hostname === 'www.github.com'
  return {
    host: u.hostname,
    origin: u.origin,
    owner,
    repo,
    releasesUrl: `${u.origin}/${owner}/${repo}/releases`,
    apiBase: isGithubCom ? 'https://api.github.com' : `${u.origin}/api/v3`,
    isGithubCom,
  }
}

/** Stable identity used for duplicate detection during import/merge. */
export function repoKey(rawUrl: string): string | null {
  const p = parseRepoUrl(rawUrl)
  if (!p) return null
  return `${p.host.toLowerCase()}/${p.owner.toLowerCase()}/${p.repo.toLowerCase()}`
}

/**
 * Fetch helper used by both retrieval methods.
 * Tries a direct browser fetch first (the normal case on GitHub Pages).
 * If the request is blocked at the network level (CORS / offline proxy),
 * it retries once through an optional same-origin proxy route. When the app
 * is deployed as a pure static site the proxy simply does not exist and the
 * original error is rethrown, so behaviour matches the "no backend" spec.
 */
async function fetchReleaseResource(url: string, accept: string): Promise<Response> {
  try {
    return await fetch(url, { headers: { Accept: accept }, cache: 'no-store' })
  } catch (directError) {
    try {
      const proxied = await fetch(
        `/api/release-proxy?url=${encodeURIComponent(url)}&accept=${encodeURIComponent(accept)}`,
        { cache: 'no-store' }
      )
      // On pure static hosting (GitHub Pages) the proxy route does not exist
      // and the SPA's HTML 404 page comes back instead. A real proxy response
      // from an upstream API is JSON, so a 404 + HTML answer means "no proxy
      // here" — keep the original direct-fetch error, which is the honest one.
      const proxyMissing =
        proxied.status === 404 &&
        (proxied.headers.get('content-type') ?? '').includes('text/html')
      if (!proxyMissing) return proxied
    } catch {
      // Proxy unreachable — fall through to the direct error.
    }
    throw directError
  }
}

function friendlyNetworkError(err: unknown, what: string): SourceError {
  if (err instanceof SourceError) return err
  const msg = err instanceof Error ? err.message : String(err)
  return new SourceError(`${what}: ${msg}`)
}

/* ----------------------------- API method ----------------------------- */

interface ApiAsset {
  name?: unknown
  browser_download_url?: unknown
  size?: unknown
}

interface ApiRelease {
  id?: unknown
  tag_name?: unknown
  name?: unknown
  html_url?: unknown
  published_at?: unknown
  body?: unknown
  prerelease?: unknown
  draft?: unknown
  assets?: ApiAsset[]
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function mapApiAssets(release: ApiRelease): AssetInfo[] {
  if (!Array.isArray(release.assets)) return []
  return release.assets
    .filter((a) => typeof a?.name === 'string' && typeof a?.browser_download_url === 'string')
    .map((a) => ({
      name: a.name as string,
      url: a.browser_download_url as string,
      size: typeof a.size === 'number' ? a.size : null,
    }))
}

function asSourceError(err: unknown): SourceError {
  if (err instanceof SourceError) return err
  const msg = err instanceof Error ? err.message : String(err)
  return new SourceError(`network request failed: ${msg}`)
}

/**
 * REST roots to try for a repository host. github.com has a single canonical
 * root; other hosts may be Forgejo/Gitea (/api/v1) or GitHub Enterprise
 * (/api/v3) — both serve GitHub-shaped release data, so both are tried.
 */
function apiCandidates(p: ParsedRepoUrl): string[] {
  if (p.isGithubCom) return [p.apiBase]
  return [`${p.origin}/api/v1`, `${p.origin}/api/v3`]
}

async function tryApiCandidate(base: string, p: ParsedRepoUrl): Promise<ReleaseInfo | 'empty'> {
  const url = `${base}/repos/${p.owner}/${p.repo}/releases?per_page=15`
  let res: Response
  try {
    res = await fetchReleaseResource(url, 'application/vnd.github+json')
  } catch (err) {
    throw asSourceError(err)
  }

  if (res.status === 404) {
    throw new SourceError('repository not found (wrong owner/repo, private repo, or API disabled on this server)')
  }
  if (res.status === 403 || res.status === 429) {
    throw new SourceError('the API refused the request (rate limit or forbidden); try again later')
  }
  if (!res.ok) {
    throw new SourceError(`request failed with HTTP ${res.status}`)
  }
  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes('json')) {
    throw new SourceError('the endpoint did not return JSON — it is probably not a GitHub-compatible server')
  }

  let list: unknown
  try {
    list = await res.json()
  } catch {
    throw new SourceError('the API returned malformed JSON')
  }
  if (!Array.isArray(list)) {
    throw new SourceError('unexpected API response shape (expected an array of releases)')
  }

  const release = (list as ApiRelease[]).find((r) => r && r.draft !== true && typeof r.tag_name === 'string')
  if (!release) return 'empty'

  return {
    releaseId: release.id != null ? String(release.id) : null,
    tag: release.tag_name as string,
    title: asString(release.name),
    publishedAt: asString(release.published_at),
    htmlUrl: asString(release.html_url) ?? p.releasesUrl,
    notes: asString(release.body),
    prerelease: release.prerelease === true,
    assets: mapApiAssets(release),
    fetchedVia: 'api',
    fetchedAt: new Date().toISOString(),
  }
}

async function fetchViaApi(p: ParsedRepoUrl): Promise<ReleaseInfo | 'empty'> {
  const candidates = apiCandidates(p)
  const problems: string[] = []

  for (const base of candidates) {
    try {
      return await tryApiCandidate(base, p)
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err))
    }
  }

  if (candidates.length === 1) {
    const msg = problems[0]
    throw new SourceError(
      p.isGithubCom
        ? `Could not reach the GitHub API: ${msg}`
        : `Could not reach the API endpoint of this server: ${msg}`
    )
  }

  const tried = candidates.map((c) => new URL(c).pathname).join(' and ')
  const unique = [...new Set(problems)].join('; ')
  throw new SourceError(
    `Could not reach the API endpoint of this server (tried ${tried}): ${unique}. ` +
      'If this is CORS-related, the server must send Access-Control-Allow-Origin headers for a browser to read its responses.'
  )
}

/* ----------------------------- HTML method ----------------------------- */

const SIZE_TEXT_RE = /(\d+(?:[.,]\d+)?)\s?(B|KB|MB|GB|TB)/i

function sizeTextToBytes(num: string, unit: string): number | null {
  const n = Number(num.replace(',', '.'))
  if (!Number.isFinite(n)) return null
  const mult: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }
  return Math.round(n * (mult[unit.toUpperCase()] ?? 1))
}

function parseReleasesHtml(html: string, baseUrl: string): ReleaseInfo | null {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const anchors = Array.from(doc.querySelectorAll('a[href]')) as HTMLAnchorElement[]
  const tagAnchor = anchors.find((a) => {
    const href = a.getAttribute('href') ?? ''
    return /\/releases\/tag\/[^/]+/.test(href) && !href.includes('expanded_assets')
  })
  if (!tagAnchor) return null

  const href = tagAnchor.getAttribute('href') ?? ''
  const rawTag = href.split('/releases/tag/')[1] ?? ''
  const tag = decodeURIComponent(rawTag.split('?')[0])
  if (!tag) return null

  const section =
    (tagAnchor.closest('section') as HTMLElement | null) ??
    (tagAnchor.closest('article') as HTMLElement | null) ??
    (tagAnchor.closest('li') as HTMLElement | null) ??
    doc.body

  const heading = section.querySelector('h2, h1')
  const title = (heading?.textContent ?? tagAnchor.textContent ?? tag).trim() || tag
  const relTime = section.querySelector('relative-time')
  const publishedAt = relTime?.getAttribute('datetime') ?? null
  const prerelease = /pre-release/i.test(section.textContent ?? '')

  const notesEl = section.querySelector('.markdown-body')
  const notes = notesEl?.textContent?.trim() || null

  let htmlUrl: string
  try {
    htmlUrl = new URL(href, baseUrl).toString()
  } catch {
    htmlUrl = baseUrl
  }

  return {
    releaseId: null,
    tag,
    title,
    publishedAt,
    htmlUrl,
    notes,
    prerelease,
    assets: [], // filled by fetchHtmlAssets below
    fetchedVia: 'html',
    fetchedAt: new Date().toISOString(),
  }
}

/** GitHub serves the asset list for a release as a small HTML fragment. */
async function fetchHtmlAssets(p: ParsedRepoUrl, tag: string): Promise<AssetInfo[]> {
  const fragUrl = `${p.origin}/${p.owner}/${p.repo}/releases/expanded_assets/${encodeURIComponent(tag)}`
  const res = await fetchReleaseResource(fragUrl, 'text/html')
  if (!res.ok) return []
  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes('html')) return []

  const doc = new DOMParser().parseFromString(await res.text(), 'text/html')
  const links = Array.from(doc.querySelectorAll('a[href*="/releases/download/"]')) as HTMLAnchorElement[]
  const assets: AssetInfo[] = []
  for (const a of links) {
    const href = a.getAttribute('href')
    if (!href) continue
    let url: string
    try {
      url = new URL(href, fragUrl).toString()
    } catch {
      continue
    }
    const pathPart = url.split('/releases/download/')[1] ?? ''
    const name = decodeURIComponent(pathPart.split('/').pop() ?? 'asset')
    const li = a.closest('li')
    const m = li?.textContent?.match(SIZE_TEXT_RE)
    assets.push({
      name,
      url,
      size: m ? sizeTextToBytes(m[1], m[2]) : null,
    })
  }
  return assets
}

async function fetchViaHtml(p: ParsedRepoUrl): Promise<ReleaseInfo | 'empty'> {
  let res: Response
  try {
    res = await fetchReleaseResource(p.releasesUrl, 'text/html')
  } catch (err) {
    throw friendlyNetworkError(
      err,
      'HTML parsing was blocked (CORS or network). The server must allow cross-origin requests for HTML fallback to work; API access is recommended'
    )
  }
  if (!res.ok) {
    throw new SourceError(`Release page returned HTTP ${res.status}.`)
  }
  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes('html')) {
    throw new SourceError('Release page did not return HTML.')
  }

  const release = parseReleasesHtml(await res.text(), p.releasesUrl)
  if (!release) return 'empty'

  try {
    release.assets = await fetchHtmlAssets(p, release.tag)
  } catch {
    // Asset list is best-effort; the release itself is still usable.
    release.assets = []
  }
  return release
}

/* ------------------------------ entrypoint ------------------------------ */

export type FetchResult = ReleaseInfo | 'empty'

/**
 * Fetch the latest published release for a repository release page URL.
 * Tries the structured API first, then falls back to HTML parsing.
 */
export async function fetchLatestRelease(repoUrl: string): Promise<FetchResult> {
  const parsed = parseRepoUrl(repoUrl)
  if (!parsed) {
    throw new SourceError('Unrecognized repository URL. Expected something like https://github.com/owner/repo/releases')
  }

  let apiError: unknown
  try {
    return await fetchViaApi(parsed)
  } catch (err) {
    apiError = err
  }

  try {
    return await fetchViaHtml(parsed)
  } catch (htmlError) {
    const apiMsg = apiError instanceof Error ? apiError.message : String(apiError)
    const htmlMsg = htmlError instanceof Error ? htmlError.message : String(htmlError)
    throw new SourceError(`${apiMsg} — HTML fallback also failed: ${htmlMsg}`)
  }
}
