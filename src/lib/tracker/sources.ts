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
 * that server sends Access-Control-Allow-Origin headers. Many self-hosted
 * Forgejo/Gitea instances (git.eden-emu.dev among them) do not, so the browser
 * blocks every direct request to them. When that happens the fetch helper
 * falls back to an optional same-origin proxy route (only present in
 * server-hosted deployments) and, if the user has opted in per repository,
 * through ScraperAPI — a keyed third-party scraping service. The API key is
 * configured in Settings and stored device-locally (settings.ts); every
 * proxied request consumes ScraperAPI credits.
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
 * ScraperAPI (https://www.scraperapi.com) replaces the former public CORS
 * relays: it fetches the target URL server-side and re-serves the response
 * with permissive CORS headers, making no-CORS servers reachable from a
 * static deployment. Unlike the anonymous free relays it is a keyed service
 * — the API key is stored device-locally (settings.ts), every proxied
 * request consumes credits from the account, and the free tier is limited
 * to roughly a thousand credits per month. Usage is therefore strictly
 * opt-in per repository.
 */
const SCRAPERAPI_BASE = 'https://api.scraperapi.com/'

/** AbortSignal.timeout is not available in every target browser; degrade gracefully. */
function timeoutSignal(ms: number): AbortSignal | undefined {
  try {
    return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(ms)
      : undefined
  } catch {
    return undefined
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * The UI fires repository checks in parallel ("check all"). Without
 * coordination, simultaneous proxied requests race each other into HTTP 429s
 * — which shows up as "one repository succeeds while its neighbour fails",
 * even though both are perfectly fine — and burst through the account's
 * concurrency limit. A module-level queue serializes every ScraperAPI
 * attempt app-wide and keeps a minimum gap between request starts, so batch
 * checks politely take turns.
 */
const SCRAPE_MIN_INTERVAL_MS = 700
let scrapeQueueTail: Promise<unknown> = Promise.resolve()
let lastScrapeStartAt = 0

function enqueueScrapeAttempt<T>(task: () => Promise<T>): Promise<T> {
  const run = scrapeQueueTail.then(async () => {
    const wait = lastScrapeStartAt + SCRAPE_MIN_INTERVAL_MS - Date.now()
    if (wait > 0) await sleep(wait)
    lastScrapeStartAt = Date.now()
    return task()
  })
  // Keep the queue alive regardless of how this attempt ends.
  scrapeQueueTail = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

/**
 * Turn a non-OK ScraperAPI response into a compact, actionable description.
 * ScraperAPI returns short plain-text/HTML bodies that name the real cause
 * (invalid key, exhausted credits, concurrency limit), so surface them.
 */
async function describeScraperError(res: Response): Promise<string> {
  let body = ''
  try {
    body = (await res.text()).replace(/\s+/g, ' ').trim().slice(0, 180)
  } catch {
    // Body is optional; the status label alone still helps.
  }
  const label =
    res.status === 401
      ? 'HTTP 401 — API key rejected'
      : res.status === 403
        ? 'HTTP 403 — out of API credits or plan limit'
        : res.status === 429
          ? 'HTTP 429 — rate limited'
          : `HTTP ${res.status}`
  return body ? `${label}: ${body}` : label
}

/**
 * Thrown when the ScraperAPI path has failed for reasons that will not
 * change between retries (bad key, exhausted credits, service down).
 * Distinct from a plain SourceError so callers can stop early: there is no
 * point re-running the whole chain for the next API candidate (/api/v3
 * after /api/v1) or for the HTML fallback — both would make the same
 * doomed (and credit-consuming) proxied requests.
 */
class ScrapeExhaustedError extends SourceError {}

/**
 * Run the request through ScraperAPI and return the response.
 * "Usable" means OK, or 404 (a meaningful upstream answer — e.g. repository
 * not found — that must not trigger a retry). One polite retry is made when
 * rate-limited; key/account problems (401/403) fail immediately because
 * retrying would only burn more credits.
 */
async function fetchViaScraperApi(url: string, apiKey: string): Promise<Response> {
  if (!apiKey) {
    throw new ScrapeExhaustedError(
      'Fetch via ScraperAPI is enabled for this repository, but no ScraperAPI API key is configured. ' +
        'Add your key in Settings (the 3-dot menu) and try again.'
    )
  }
  const build = () =>
    `${SCRAPERAPI_BASE}?api_key=${encodeURIComponent(apiKey)}&url=${encodeURIComponent(url)}`
  const problems: string[] = []
  let sawRateLimit = false
  let keyProblem = false
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await enqueueScrapeAttempt(() =>
        fetch(build(), { cache: 'no-store', signal: timeoutSignal(30_000) })
      )
      if (res.ok || res.status === 404) return res
      problems.push(await describeScraperError(res))
      if (res.status === 429) sawRateLimit = true
      if (res.status === 401 || res.status === 403) {
        keyProblem = true
        break // retrying a bad key or empty quota changes nothing
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      problems.push(msg)
      if (/429|rate.?limit/i.test(msg)) sawRateLimit = true
    }
    if (attempt === 1) await sleep(1_800)
  }
  throw new ScrapeExhaustedError(
    sawRateLimit && !keyProblem
      ? `ScraperAPI is rate-limiting this device right now (${problems.join('; ')}). ` +
          'Wait a little and check again — checking repositories one at a time also helps.'
      : `ScraperAPI request failed (${problems.join('; ')})`
  )
}

/**
 * Fetch helper used by both retrieval methods.
 * Tries a direct browser fetch first (the normal case on GitHub Pages).
 * If the request is blocked at the network level (CORS / offline proxy),
 * it retries through an optional same-origin proxy route. When the app
 * is deployed as a pure static site the proxy simply does not exist; in
 * that case, and only when the user opted in with a configured key, the
 * request is routed through ScraperAPI. With everything exhausted the
 * original direct error is rethrown, so the honest root cause is never
 * masked.
 */
async function fetchReleaseResource(
  url: string,
  accept: string,
  relay: boolean,
  apiKey: string
): Promise<Response> {
  try {
    return await fetch(url, {
      headers: { Accept: accept },
      cache: 'no-store',
      signal: timeoutSignal(20_000),
    })
  } catch (directError) {
    try {
      const proxied = await fetch(
        `/api/release-proxy?url=${encodeURIComponent(url)}&accept=${encodeURIComponent(accept)}`,
        { cache: 'no-store' }
      )
      // On pure static hosting (GitHub Pages) the proxy route does not exist
      // and the SPA's HTML 404 page comes back instead. A real proxy response
      // from an upstream API is JSON, so a 404 + HTML answer means "no proxy
      // here" — keep going.
      const proxyMissing =
        proxied.status === 404 &&
        (proxied.headers.get('content-type') ?? '').includes('text/html')
      if (!proxyMissing) return proxied
    } catch {
      // Proxy unreachable — fall through.
    }
    if (relay) {
      return await fetchViaScraperApi(url, apiKey)
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

/** Errors that mean the browser could not even complete the request (CORS, DNS, offline). */
const NETWORK_FAIL_RE = /network request failed|failed to fetch|networkerror|load failed|fetch failed|scraperapi/i

function isNetworkFailure(message: string): boolean {
  return NETWORK_FAIL_RE.test(message)
}

/**
 * Actionable guidance shown when a non-GitHub server blocks browser access.
 * This is the single most common failure for self-hosted Forgejo/Gitea
 * instances, so the message must lead with the fix, not the jargon.
 */
function corsGuidanceError(p: ParsedRepoUrl, tried: string, technical: string, relay: boolean): SourceError {
  const fixes = relay
    ? 'ScraperAPI is enabled for this repository, but the proxied request failed — see the reason above. Verify that your API key (Settings → ScraperAPI) is valid and that your account still has credits, then check again.'
    : 'Fixes: enable “Fetch via ScraperAPI” for this repository (Repos → Edit) and add your ScraperAPI key in Settings (3-dot menu), track a GitHub mirror of the releases instead, or ask the server admin to enable CORS.'
  return new SourceError(
    `${p.host} blocks browser access (no CORS headers), so this app cannot read it directly` +
      (tried ? ` (tried ${tried})` : '') +
      `. ${fixes} ` +
      `(Technical detail: ${technical})`
  )
}

async function tryApiCandidate(
  base: string,
  p: ParsedRepoUrl,
  relay: boolean,
  apiKey: string
): Promise<ReleaseInfo | 'empty'> {
  const url = `${base}/repos/${p.owner}/${p.repo}/releases?per_page=15`
  let res: Response
  try {
    res = await fetchReleaseResource(url, 'application/vnd.github+json', relay, apiKey)
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

async function fetchViaApi(
  p: ParsedRepoUrl,
  relay: boolean,
  apiKey: string
): Promise<ReleaseInfo | 'empty'> {
  const candidates = apiCandidates(p)
  const problems: string[] = []

  for (const base of candidates) {
    try {
      return await tryApiCandidate(base, p, relay, apiKey)
    } catch (err) {
      // If the ScraperAPI path itself failed, every other API candidate and
      // the HTML fallback would just queue up the same doomed (and
      // credit-consuming) proxied requests — surface the summary instead.
      if (err instanceof ScrapeExhaustedError) throw err
      problems.push(err instanceof Error ? err.message : String(err))
    }
  }

  if (candidates.length === 1) {
    const msg = problems[0]
    if (!p.isGithubCom && isNetworkFailure(msg)) {
      throw corsGuidanceError(p, '', msg, relay)
    }
    throw new SourceError(
      p.isGithubCom
        ? `Could not reach the GitHub API: ${msg}`
        : `Could not reach the API endpoint of this server: ${msg}`
    )
  }

  const tried = candidates.map((c) => new URL(c).pathname).join(' and ')
  const unique = [...new Set(problems)].join('; ')
  if (problems.some(isNetworkFailure)) {
    throw corsGuidanceError(p, tried, unique, relay)
  }
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
async function fetchHtmlAssets(p: ParsedRepoUrl, tag: string, relay: boolean, apiKey: string): Promise<AssetInfo[]> {
  const fragUrl = `${p.origin}/${p.owner}/${p.repo}/releases/expanded_assets/${encodeURIComponent(tag)}`
  const res = await fetchReleaseResource(fragUrl, 'text/html', relay, apiKey)
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

async function fetchViaHtml(
  p: ParsedRepoUrl,
  relay: boolean,
  apiKey: string
): Promise<ReleaseInfo | 'empty'> {
  let res: Response
  try {
    res = await fetchReleaseResource(p.releasesUrl, 'text/html', relay, apiKey)
  } catch (err) {
    throw friendlyNetworkError(
      err,
      'HTML fallback was blocked (CORS or network); API access is recommended'
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
    release.assets = await fetchHtmlAssets(p, release.tag, relay, apiKey)
  } catch {
    // Asset list is best-effort; the release itself is still usable.
    release.assets = []
  }
  return release
}

/* ------------------------------ entrypoint ------------------------------ */

export type FetchResult = ReleaseInfo | 'empty'

export interface FetchOptions {
  /**
   * Route failed lookups through ScraperAPI (keyed third-party service;
   * strictly opt-in). Legacy field name kept for compatibility with data
   * saved by earlier versions and with exported configuration files — the
   * UI presents this as "Fetch via ScraperAPI".
   */
  relay?: boolean
  /** Device-local ScraperAPI API key (see settings.ts). */
  scraperApiKey?: string | null
}

/**
 * Fetch the latest published release for a repository release page URL.
 * Tries the structured API first, then falls back to HTML parsing.
 */
export async function fetchLatestRelease(repoUrl: string, options: FetchOptions = {}): Promise<FetchResult> {
  const parsed = parseRepoUrl(repoUrl)
  if (!parsed) {
    throw new SourceError('Unrecognized repository URL. Expected something like https://github.com/owner/repo/releases')
  }
  const relay = options.relay === true
  const apiKey = options.scraperApiKey ?? ''

  let apiError: unknown
  try {
    return await fetchViaApi(parsed, relay, apiKey)
  } catch (err) {
    apiError = err
  }

  const apiMsg = apiError instanceof Error ? apiError.message : String(apiError)
  // A network-level block (CORS, DNS, offline) kills every cross-origin
  // request to that host — the HTML fallback would fail identically, so skip
  // it instead of appending a second copy of the same wall of text.
  if (isNetworkFailure(apiMsg)) {
    throw apiError instanceof SourceError ? apiError : new SourceError(apiMsg)
  }

  try {
    return await fetchViaHtml(parsed, relay, apiKey)
  } catch (htmlError) {
    const htmlMsg = htmlError instanceof Error ? htmlError.message : String(htmlError)
    throw new SourceError(`${apiMsg} — HTML fallback also failed: ${htmlMsg}`)
  }
}

/**
 * Validate a ScraperAPI key from the Settings screen by performing one real
 * proxied request to a tiny static page. Costs a single API credit but is
 * the only reliable check — ScraperAPI's account endpoint is not available
 * on every plan. Returns a human-readable success line; throws a
 * SourceError whose message names the exact problem otherwise.
 */
export async function testScraperApiKey(key: string): Promise<string> {
  const trimmed = key.trim()
  if (!trimmed) {
    throw new SourceError('Enter an API key first.')
  }
  let res: Response
  try {
    res = await fetch(
      `${SCRAPERAPI_BASE}?api_key=${encodeURIComponent(trimmed)}&url=${encodeURIComponent('https://example.com')}`,
      { cache: 'no-store', signal: timeoutSignal(30_000) }
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new SourceError(`Could not reach ScraperAPI: ${msg}`)
  }
  if (res.ok) {
    return 'Key works — a test page was fetched successfully (1 API credit used).'
  }
  throw new SourceError(`Key test failed — ${await describeScraperError(res)}`)
}
