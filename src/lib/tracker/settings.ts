/**
 * Device-local app settings (as opposed to per-repository data, which lives
 * in IndexedDB — see storage.ts).
 *
 * The ScraperAPI key is a secret that must never ship inside the app bundle,
 * so it is not part of the source code and is not included in exported
 * configuration files. It lives only in this browser's localStorage and is
 * sent exclusively to api.scraperapi.com when a lookup needs its proxy.
 */

const KEY_STORAGE = 'emutrack.scraperApiKey'

export function loadScraperApiKey(): string {
  try {
    return (localStorage.getItem(KEY_STORAGE) ?? '').trim()
  } catch {
    // localStorage can throw in private modes with storage disabled.
    return ''
  }
}

export function saveScraperApiKey(key: string): void {
  try {
    localStorage.setItem(KEY_STORAGE, key.trim())
  } catch {
    // Silently ignore: without storage the key simply has to be re-entered
    // per session; the UI already treats an empty key as "not configured".
  }
}

export function hasScraperApiKey(): boolean {
  return loadScraperApiKey().length > 0
}
