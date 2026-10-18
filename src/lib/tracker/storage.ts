/**
 * Local persistence for repositories using IndexedDB.
 * One object store ("repos") keyed by repo id. Every mutation is written
 * immediately so the app can be killed at any time without data loss.
 */
import type { TrackedRepo } from './types'

const DB_NAME = 'emutrack'
const DB_VERSION = 1
const STORE = 'repos'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available in this browser.'))
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB.'))
  })
  return dbPromise
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed.'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted.'))
  })
}

export async function loadRepos(): Promise<TrackedRepo[]> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).getAll()
    req.onsuccess = () => {
      const rows = (req.result ?? []) as TrackedRepo[]
      rows.sort((a, b) => a.name.localeCompare(b.name))
      resolve(rows)
    }
    req.onerror = () => reject(req.error ?? new Error('Failed to read repositories.'))
  })
}

export async function saveRepo(repo: TrackedRepo): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(STORE, 'readwrite')
  tx.objectStore(STORE).put(repo)
  await txDone(tx)
}

export async function deleteRepo(id: string): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(STORE, 'readwrite')
  tx.objectStore(STORE).delete(id)
  await txDone(tx)
}

/** Replace the entire store in a single transaction (used by config import). */
export async function replaceAllRepos(repos: TrackedRepo[]): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(STORE, 'readwrite')
  const store = tx.objectStore(STORE)
  store.clear()
  for (const repo of repos) {
    store.put(repo)
  }
  await txDone(tx)
}
