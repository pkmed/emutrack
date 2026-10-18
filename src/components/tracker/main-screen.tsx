'use client'

import { CircleAlert, Eye, Loader2, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { isPending, type TrackedRepo } from '@/lib/tracker/types'
import { timeAgo } from '@/lib/tracker/format'

interface MainScreenProps {
  repos: TrackedRepo[]
  loaded: boolean
  checkingAll: boolean
  checkingIds: ReadonlySet<string>
  onCheckAll: () => void
  onCheckRepo: (id: string) => void
  onMarkSeen: (id: string) => void
  onOpenDetails: (id: string) => void
  onManageRepos: () => void
}

function statusLine(repo: TrackedRepo, checking: boolean): { text: string; error: boolean } {
  if (checking) return { text: 'Checking…', error: false }
  if (repo.lastStatus === 'error' && repo.lastError) {
    return { text: `Check failed: ${repo.lastError}`, error: true }
  }
  if (repo.lastStatus === 'empty') {
    return { text: `No releases found · checked ${timeAgo(repo.lastCheckedAt)}`, error: false }
  }
  if (repo.lastStatus === 'ok') {
    return { text: `Checked ${timeAgo(repo.lastCheckedAt)}`, error: false }
  }
  return { text: 'Not checked yet', error: false }
}

export function MainScreen({
  repos,
  loaded,
  checkingAll,
  checkingIds,
  onCheckAll,
  onCheckRepo,
  onMarkSeen,
  onOpenDetails,
  onManageRepos,
}: MainScreenProps) {
  if (!loaded) {
    return (
      <div className="flex flex-col gap-4 py-4" aria-busy="true" aria-label="Loading repositories">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-36 w-full" />
        <Skeleton className="h-36 w-full" />
      </div>
    )
  }

  if (repos.length === 0) {
    return (
      <div className="py-4">
        <Card>
          <CardContent className="flex flex-col items-center gap-4 p-8 text-center">
            <p className="max-w-sm text-sm text-muted-foreground">
              Track releases of your favorite emulators hosted on GitHub or compatible self-hosted
              instances. Add your first repository to get started.
            </p>
            <Button onClick={onManageRepos}>
              Add a repository
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  const pendingCount = repos.filter(isPending).length

  return (
    <div className="py-4">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {checkingAll
            ? 'Checking all repositories…'
            : pendingCount > 0
              ? `${pendingCount} of ${repos.length} ${repos.length === 1 ? 'repository has' : 'repositories have'} unseen releases`
              : 'All releases acknowledged'}
        </p>
        <Button onClick={onCheckAll} disabled={checkingAll} className="w-full sm:w-auto">
          {checkingAll ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <RefreshCw className="h-4 w-4" aria-hidden />
          )}
          Check updates
        </Button>
      </div>

      <ul className="flex flex-col gap-3" aria-label="Tracked emulators">
        {repos.map((repo) => {
          const checking = checkingIds.has(repo.id)
          const pending = isPending(repo)
          const status = statusLine(repo, checking)
          return (
            <li key={repo.id}>
              <Card className={pending ? 'border-amber-500/40' : undefined}>
                <CardContent className="flex flex-col gap-3 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <button
                      type="button"
                      className="min-w-0 truncate text-left font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                      onClick={() => onOpenDetails(repo.id)}
                      aria-label={`Open release details for ${repo.name}`}
                    >
                      {repo.name}
                    </button>
                    {pending ? (
                      <Badge className="shrink-0 border-amber-500/30 bg-amber-500/15 text-amber-600 dark:text-amber-400">
                        New release
                      </Badge>
                    ) : repo.lastStatus === 'ok' ? (
                      <Badge variant="secondary" className="shrink-0">
                        Up to date
                      </Badge>
                    ) : null}
                  </div>

                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                    <div className="min-w-0">
                      <dt className="text-xs text-muted-foreground">Acknowledged</dt>
                      <dd className="truncate font-mono text-sm" title={repo.acknowledged?.tag ?? undefined}>
                        {repo.acknowledged?.tag ?? '—'}
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-xs text-muted-foreground">Latest</dt>
                      <dd
                        className={`truncate font-mono text-sm ${pending ? 'font-semibold' : ''}`}
                        title={repo.latest?.tag ?? undefined}
                      >
                        {repo.latest?.tag ?? '—'}
                      </dd>
                    </div>
                  </dl>

                  <div className="flex items-center justify-between gap-2">
                    <p
                      className={`flex min-w-0 items-center gap-1.5 text-xs ${status.error ? 'text-destructive' : 'text-muted-foreground'}`}
                      title={status.text}
                    >
                      {checking ? (
                        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
                      ) : status.error ? (
                        <CircleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
                      ) : null}
                      <span className="line-clamp-2">{status.text}</span>
                    </p>
                    {pending && (
                      <Button size="sm" onClick={() => onMarkSeen(repo.id)} className="shrink-0">
                        <Eye className="h-4 w-4" aria-hidden />
                        Mark as seen
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
