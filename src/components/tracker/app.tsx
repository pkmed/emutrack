'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Database, EllipsisVertical } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Toaster } from '@/components/ui/sonner'
import { DetailsScreen } from '@/components/tracker/details-screen'
import { MainScreen } from '@/components/tracker/main-screen'
import { ReposScreen, type RepoDraft } from '@/components/tracker/repos-screen'
import { SettingsScreen } from '@/components/tracker/settings-screen'
import { ThemeToggle } from '@/components/tracker/theme-toggle'
import { fetchLatestRelease, repoKey } from '@/lib/tracker/sources'
import { loadScraperApiKey } from '@/lib/tracker/settings'
import {
  deleteRepo as dbDeleteRepo,
  loadRepos,
  replaceAllRepos,
  saveRepo as dbSaveRepo,
} from '@/lib/tracker/storage'
import {
  newId,
  type ExportConfig,
  type ExportedRepo,
  type TrackedRepo,
} from '@/lib/tracker/types'

type View = { name: 'main' } | { name: 'repos' } | { name: 'settings' } | { name: 'details'; repoId: string }

interface PendingImport {
  repos: ExportedRepo[]
}

function repoFromExport(e: ExportedRepo): TrackedRepo {
  const tag = e.lastAcknowledgedVersion
  return {
    id: newId(),
    name: e.name,
    url: e.url,
    acknowledged: tag
      ? {
          releaseId: e.lastAcknowledgedReleaseId ?? null,
          tag,
          title: e.lastAcknowledgedTitle ?? null,
          publishedAt: e.lastAcknowledgedPublishedAt ?? null,
        }
      : null,
    latest: null,
    lastCheckedAt: null,
    lastError: null,
    lastStatus: 'idle',
    relay: e.relay === true,
  }
}

function validateImportFile(json: unknown): { ok: true; repos: ExportedRepo[] } | { ok: false; error: string } {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return { ok: false, error: 'Not a valid configuration file (expected a JSON object).' }
  }
  const obj = json as Record<string, unknown>
  if (obj.version !== 1) {
    return { ok: false, error: `Unsupported configuration version: ${String(obj.version)}. This app understands version 1.` }
  }
  if (!Array.isArray(obj.repositories)) {
    return { ok: false, error: 'Missing "repositories" array.' }
  }
  const out: ExportedRepo[] = []
  for (let i = 0; i < obj.repositories.length; i++) {
    const item = obj.repositories[i] as Record<string, unknown> | null
    if (typeof item !== 'object' || item === null) {
      return { ok: false, error: `Repository #${i + 1} is not an object.` }
    }
    const name = typeof item.name === 'string' ? item.name.trim() : ''
    const url = typeof item.url === 'string' ? item.url.trim() : ''
    if (!name) return { ok: false, error: `Repository #${i + 1} is missing a name.` }
    if (!url || !/^https?:\/\//i.test(url)) {
      return { ok: false, error: `Repository "${name}" does not have a valid http(s) URL.` }
    }
    out.push({
      name,
      url,
      lastAcknowledgedVersion: typeof item.lastAcknowledgedVersion === 'string' ? item.lastAcknowledgedVersion : null,
      lastAcknowledgedReleaseId:
        typeof item.lastAcknowledgedReleaseId === 'string' ? item.lastAcknowledgedReleaseId : null,
      lastAcknowledgedTitle: typeof item.lastAcknowledgedTitle === 'string' ? item.lastAcknowledgedTitle : null,
      lastAcknowledgedPublishedAt:
        typeof item.lastAcknowledgedPublishedAt === 'string' ? item.lastAcknowledgedPublishedAt : null,
      relay: item.relay === true,
    })
  }
  return { ok: true, repos: out }
}

export default function EmuTrackApp() {
  const [repos, setRepos] = useState<TrackedRepo[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [view, setView] = useState<View>({ name: 'main' })
  const [checkingAll, setCheckingAll] = useState(false)
  const [checkingIds, setCheckingIds] = useState<ReadonlySet<string>>(new Set())
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null)
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge')

  // Mirrors of state for use inside stable async callbacks.
  const reposRef = useRef<TrackedRepo[]>([])
  const checkingRef = useRef(false)
  const checkingIdsRef = useRef<Set<string>>(new Set())
  const fileInputRef = useRef<HTMLInputElement>(null)

  const applyRepos = useCallback((next: TrackedRepo[]) => {
    const sorted = [...next].sort((a, b) => a.name.localeCompare(b.name))
    reposRef.current = sorted
    setRepos(sorted)
  }, [])

  useEffect(() => {
    loadRepos()
      .then((rows) => {
        applyRepos(rows)
        setLoaded(true)
      })
      .catch((err: unknown) => {
        setLoadError(err instanceof Error ? err.message : 'Failed to open local storage.')
        setLoaded(true)
      })
  }, [applyRepos])

  /* ------------------------------ mutations ------------------------------ */

  const mutateRepo = useCallback(
    async (id: string, patch: Partial<TrackedRepo>) => {
      const current = reposRef.current.find((r) => r.id === id)
      if (!current) return
      const updated: TrackedRepo = { ...current, ...patch }
      applyRepos(reposRef.current.map((r) => (r.id === id ? updated : r)))
      try {
        await dbSaveRepo(updated)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not save to local storage.')
      }
    },
    [applyRepos]
  )

  const handleSaveRepo = useCallback(
    async (draft: RepoDraft) => {
      const existing = reposRef.current.find((r) => r.id === draft.id)
      if (existing) {
        await mutateRepo(draft.id, { name: draft.name, url: draft.url, relay: draft.relay })
        toast.success('Repository updated')
      } else {
        const repo: TrackedRepo = {
          id: draft.id,
          name: draft.name,
          url: draft.url,
          acknowledged: null,
          latest: null,
          lastCheckedAt: null,
          lastError: null,
          lastStatus: 'idle',
          relay: draft.relay,
        }
        applyRepos([...reposRef.current, repo])
        try {
          await dbSaveRepo(repo)
          toast.success('Repository added')
        } catch (err) {
          toast.error(err instanceof Error ? err.message : 'Could not save to local storage.')
        }
      }
    },
    [applyRepos, mutateRepo]
  )

  const handleDeleteRepo = useCallback(
    async (id: string) => {
      applyRepos(reposRef.current.filter((r) => r.id !== id))
      if (view.name === 'details' && view.repoId === id) setView({ name: 'main' })
      try {
        await dbDeleteRepo(id)
        toast.success('Repository deleted')
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not delete from local storage.')
      }
    },
    [applyRepos, view]
  )

  /* ------------------------------- checking ------------------------------ */

  const checkRepo = useCallback(
    async (id: string) => {
      const repo = reposRef.current.find((r) => r.id === id)
      if (!repo) return
      if (checkingIdsRef.current.has(id)) return // prevent duplicate concurrent checks
      checkingIdsRef.current.add(id)
      setCheckingIds(new Set(checkingIdsRef.current))
      const now = new Date().toISOString()
      try {
        const result = await fetchLatestRelease(repo.url, {
          relay: repo.relay === true,
          scraperApiKey: loadScraperApiKey(),
        })
        if (result === 'empty') {
          await mutateRepo(id, { latest: null, lastCheckedAt: now, lastStatus: 'empty', lastError: null })
        } else {
          await mutateRepo(id, { latest: result, lastCheckedAt: now, lastStatus: 'ok', lastError: null })
        }
      } catch (err) {
        await mutateRepo(id, {
          lastCheckedAt: now,
          lastStatus: 'error',
          lastError: err instanceof Error ? err.message : String(err),
        })
      } finally {
        checkingIdsRef.current.delete(id)
        setCheckingIds(new Set(checkingIdsRef.current))
      }
    },
    [mutateRepo]
  )

  const checkAll = useCallback(async () => {
    if (checkingRef.current) return
    checkingRef.current = true
    setCheckingAll(true)
    const ids = reposRef.current.map((r) => r.id)
    await Promise.allSettled(ids.map((id) => checkRepo(id)))
    checkingRef.current = false
    setCheckingAll(false)
  }, [checkRepo])

  const markSeen = useCallback(
    (id: string) => {
      const repo = reposRef.current.find((r) => r.id === id)
      if (!repo?.latest) return
      void mutateRepo(id, {
        acknowledged: {
          releaseId: repo.latest.releaseId,
          tag: repo.latest.tag,
          title: repo.latest.title,
          publishedAt: repo.latest.publishedAt,
        },
      })
      toast.success(`Marked ${repo.latest.tag} as seen`)
    },
    [mutateRepo]
  )

  /* --------------------------- import / export --------------------------- */

  const exportConfig = useCallback(() => {
    const config: ExportConfig = {
      version: 1,
      exportedAt: new Date().toISOString(),
      repositories: reposRef.current.map((r) => ({
        name: r.name,
        url: r.url,
        lastAcknowledgedVersion: r.acknowledged?.tag ?? null,
        lastAcknowledgedReleaseId: r.acknowledged?.releaseId ?? null,
        lastAcknowledgedTitle: r.acknowledged?.title ?? null,
        lastAcknowledgedPublishedAt: r.acknowledged?.publishedAt ?? null,
        ...(r.relay ? { relay: true } : {}),
      })),
    }
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `emutrack-config-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    toast.success('Configuration exported')
  }, [])

  const onImportFile = useCallback(async (file: File) => {
    let text: string
    try {
      text = await file.text()
    } catch {
      toast.error('Could not read the selected file.')
      return
    }
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      toast.error('The file is not valid JSON.')
      return
    }
    const parsed = validateImportFile(json)
    if (!parsed.ok) {
      toast.error(parsed.error)
      return
    }
    setImportMode('merge')
    setPendingImport({ repos: parsed.repos })
  }, [])

  const applyImport = useCallback(
    async (mode: 'merge' | 'replace') => {
      if (!pendingImport) return
      try {
        if (mode === 'replace') {
          const next = pendingImport.repos.map(repoFromExport)
          await replaceAllRepos(next)
          applyRepos(next)
          toast.success(`Configuration replaced (${next.length} ${next.length === 1 ? 'repository' : 'repositories'})`)
        } else {
          const merged = [...reposRef.current]
          const keys = new Set(merged.map((r) => repoKey(r.url)).filter((k): k is string => k !== null))
          let added = 0
          let skipped = 0
          for (const e of pendingImport.repos) {
            const key = repoKey(e.url)
            if (key && keys.has(key)) {
              skipped += 1
              continue
            }
            if (key) keys.add(key)
            merged.push(repoFromExport(e))
            added += 1
          }
          await replaceAllRepos(merged)
          applyRepos(merged)
          toast.success(
            added > 0
              ? `Added ${added} ${added === 1 ? 'repository' : 'repositories'}${skipped > 0 ? `, skipped ${skipped} duplicate${skipped === 1 ? '' : 's'}` : ''}`
              : 'Nothing new to import (all duplicates)'
          )
        }
      } catch (err) {
        // Failed import leaves the current configuration untouched.
        toast.error(err instanceof Error ? err.message : 'Import failed; configuration unchanged.')
      } finally {
        setPendingImport(null)
      }
    },
    [applyRepos, pendingImport]
  )

  /* -------------------------------- render ------------------------------- */

  const detailsRepo = view.name === 'details' ? repos.find((r) => r.id === view.repoId) : undefined
  const effectiveView: View = view.name === 'details' && !detailsRepo ? { name: 'main' } : view

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        aria-hidden
        tabIndex={-1}
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (file) void onImportFile(file)
        }}
      />

      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4">
        <header className="flex items-center justify-between gap-2 border-b py-3">
          <button
            type="button"
            className="flex min-w-0 items-center gap-2 rounded-md focus-visible:outline-2 focus-visible:outline-ring"
            onClick={() => setView({ name: 'main' })}
            aria-label="EmuTrack home"
          >
            <img src="./icon-192.png" alt="EmuTrack logo" className="h-8 w-8 rounded-lg" />
            <span className="text-lg font-semibold tracking-tight">EmuTrack</span>
          </button>
          <div className="flex items-center gap-1">
            <ThemeToggle />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setView({ name: 'repos' })}
              aria-label="Manage repositories"
            >
              <Database className="h-5 w-5" aria-hidden />
              <span className="hidden sm:inline">Repos</span>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setView({ name: 'settings' })}
              aria-label="Open settings"
            >
              <EllipsisVertical className="h-5 w-5" aria-hidden />
            </Button>
          </div>
        </header>

        <main className="flex-1">
          {loadError ? (
            <div className="py-10 text-center text-sm text-destructive" role="alert">
              {loadError}
            </div>
          ) : effectiveView.name === 'main' ? (
            <MainScreen
              repos={repos}
              loaded={loaded}
              checkingAll={checkingAll}
              checkingIds={checkingIds}
              onCheckAll={() => void checkAll()}
              onCheckRepo={(id) => void checkRepo(id)}
              onMarkSeen={markSeen}
              onOpenDetails={(id) => setView({ name: 'details', repoId: id })}
              onManageRepos={() => setView({ name: 'repos' })}
            />
          ) : effectiveView.name === 'repos' ? (
            <ReposScreen
              repos={repos}
              onBack={() => setView({ name: 'main' })}
              onSave={handleSaveRepo}
              onDelete={handleDeleteRepo}
            />
          ) : effectiveView.name === 'settings' ? (
            <SettingsScreen
              onBack={() => setView({ name: 'main' })}
              onExport={() => exportConfig()}
              onImport={() => fileInputRef.current?.click()}
            />
          ) : (
            detailsRepo && (
              <DetailsScreen
                repo={detailsRepo}
                checking={checkingIds.has(detailsRepo.id)}
                onBack={() => setView({ name: 'main' })}
                onCheck={(id) => void checkRepo(id)}
                onMarkSeen={markSeen}
              />
            )
          )}
        </main>
      </div>

      <footer className="mt-auto border-t px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4 text-center text-xs text-muted-foreground">
        EmuTrack · All data stays on this device · No notifications, no background checks
      </footer>

      {/* Import dialog */}
      <Dialog open={pendingImport !== null} onOpenChange={(open) => !open && setPendingImport(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Import configuration</DialogTitle>
            <DialogDescription>
              Found {pendingImport?.repos.length ?? 0}{' '}
              {pendingImport?.repos.length === 1 ? 'repository' : 'repositories'} in the selected file.
            </DialogDescription>
          </DialogHeader>
          <RadioGroup value={importMode} onValueChange={(v) => setImportMode(v as 'merge' | 'replace')}>
            <div className="flex items-start gap-3">
              <RadioGroupItem value="merge" id="import-mode-merge" className="mt-0.5" />
              <div className="grid gap-1">
                <Label htmlFor="import-mode-merge" className="font-medium">
                  Merge
                </Label>
                <p className="text-sm text-muted-foreground">
                  Add repositories that do not exist yet (duplicates by URL are skipped). Keeps
                  current data.
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <RadioGroupItem value="replace" id="import-mode-replace" className="mt-0.5" />
              <div className="grid gap-1">
                <Label htmlFor="import-mode-replace" className="font-medium">
                  Replace
                </Label>
                <p className="text-sm text-muted-foreground">
                  Remove all current repositories and import the file contents instead.
                </p>
              </div>
            </div>
          </RadioGroup>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingImport(null)}>
              Cancel
            </Button>
            <Button onClick={() => void applyImport(importMode)}>
              {importMode === 'merge' ? 'Merge' : 'Replace'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Toaster position="top-center" richColors closeButton />
    </>
  )
}
