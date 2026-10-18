/**
 * Shared data model for the EmuTrack release tracker.
 * All data lives on-device (IndexedDB); nothing is synced anywhere.
 */

/** The release the user has acknowledged with "Mark as seen". */
export interface AckRecord {
  /** Stable release identifier when the source provides one (GitHub release id). */
  releaseId: string | null
  /** Tag of the acknowledged release (e.g. "v1.2.0"). */
  tag: string
  title: string | null
  publishedAt: string | null
}

export interface AssetInfo {
  name: string
  url: string
  /** Size in bytes when the source provides it. */
  size: number | null
}

export interface ReleaseInfo {
  releaseId: string | null
  tag: string
  title: string | null
  publishedAt: string | null
  htmlUrl: string
  notes: string | null
  prerelease: boolean
  assets: AssetInfo[]
  /** Which retrieval method produced this release. */
  fetchedVia: 'api' | 'html'
  /** ISO timestamp of when this release was fetched. */
  fetchedAt: string
}

export type CheckStatus = 'idle' | 'ok' | 'empty' | 'error'

export interface TrackedRepo {
  id: string
  name: string
  /** Release page URL as entered by the user. */
  url: string
  acknowledged: AckRecord | null
  /** Last successfully detected release (cache from the most recent check). */
  latest: ReleaseInfo | null
  lastCheckedAt: string | null
  lastError: string | null
  lastStatus: CheckStatus
  /**
   * Opt-in fallback for servers that block browser access (no CORS
   * headers): retry lookups through a public relay service. Requests then
   * pass through a third party, so this is off unless the user enables it.
   */
  relay?: boolean
}

/** JSON backup schema (spec version 1). */
export interface ExportConfig {
  version: 1
  exportedAt: string
  repositories: ExportedRepo[]
}

export interface ExportedRepo {
  name: string
  url: string
  lastAcknowledgedVersion: string | null
  lastAcknowledgedReleaseId?: string | null
  lastAcknowledgedTitle?: string | null
  lastAcknowledgedPublishedAt?: string | null
  /** Optional device-local preference, carried along additively (v1 readers ignore unknown fields). */
  relay?: boolean
}

/** A release is pending when its identity differs from the last acknowledged one. */
export function isPending(repo: TrackedRepo): boolean {
  if (!repo.latest) return false
  const ack = repo.acknowledged
  if (!ack) return true
  if (repo.latest.releaseId && ack.releaseId) {
    return repo.latest.releaseId !== ack.releaseId
  }
  return repo.latest.tag !== ack.tag
}

export function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}
