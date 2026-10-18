'use client'

import { useState } from 'react'
import {
  ArrowLeft,
  CalendarDays,
  CircleAlert,
  Download,
  ExternalLink,
  Eye,
  Loader2,
  Package,
  RefreshCw,
  Smartphone,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { formatDate, formatSize, isApkAsset, timeAgo } from '@/lib/tracker/format'
import { isPending, type TrackedRepo } from '@/lib/tracker/types'

interface DetailsScreenProps {
  repo: TrackedRepo
  checking: boolean
  onBack: () => void
  onCheck: (id: string) => void
  onMarkSeen: (id: string) => void
}

export function DetailsScreen({ repo, checking, onBack, onCheck, onMarkSeen }: DetailsScreenProps) {
  const [apkOnly, setApkOnly] = useState(true)
  const latest = repo.latest
  const pending = isPending(repo)

  const assets = latest?.assets ?? []
  const visibleAssets = apkOnly ? assets.filter((a) => isApkAsset(a.name)) : assets

  return (
    <div className="py-4">
      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1">
          <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back to main screen">
            <ArrowLeft className="h-5 w-5" aria-hidden />
          </Button>
          <h1 className="min-w-0 truncate text-lg font-semibold" title={repo.name}>
            {repo.name}
          </h1>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {pending && (
            <Button size="sm" variant="outline" onClick={() => onMarkSeen(repo.id)}>
              <Eye className="h-4 w-4" aria-hidden />
              Mark as seen
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onCheck(repo.id)}
            disabled={checking}
            aria-label="Check this repository for updates"
          >
            {checking ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="h-4 w-4" aria-hidden />
            )}
            <span className="hidden sm:inline">Check</span>
          </Button>
        </div>
      </div>

      {!latest ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-4 p-8 text-center">
            <p className="max-w-sm text-sm text-muted-foreground">
              No release data for this repository yet. Run a check to fetch its latest release.
            </p>
            {repo.lastStatus === 'error' && repo.lastError && (
              <p className="flex items-start gap-1.5 text-sm text-destructive">
                <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <span>{repo.lastError}</span>
              </p>
            )}
            <Button onClick={() => onCheck(repo.id)} disabled={checking}>
              {checking ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <RefreshCw className="h-4 w-4" aria-hidden />
              )}
              Check for updates
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {/* Release summary */}
          <Card>
            <CardContent className="flex flex-col gap-3 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary" className="font-mono">
                  {latest.tag}
                </Badge>
                {latest.prerelease && <Badge variant="outline">Pre-release</Badge>}
                {pending && (
                  <Badge className="border-amber-500/30 bg-amber-500/15 text-amber-600 dark:text-amber-400">
                    New release
                  </Badge>
                )}
              </div>

              {latest.title && latest.title !== latest.tag && (
                <h2 className="text-base font-semibold leading-snug">{latest.title}</h2>
              )}

              <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <CalendarDays className="h-4 w-4" aria-hidden />
                Published {formatDate(latest.publishedAt)}
              </p>

              <p className="text-xs text-muted-foreground">
                Fetched {timeAgo(latest.fetchedAt)} via{' '}
                {latest.fetchedVia === 'api' ? 'the GitHub API' : 'HTML parsing'}
              </p>

              {latest.notes && (
                <div className="scrollbar-thin max-h-96 overflow-y-auto rounded-md bg-muted/60 p-3 text-sm leading-relaxed whitespace-pre-wrap">
                  {latest.notes}
                </div>
              )}

              <Button asChild variant="outline" className="w-fit">
                <a href={latest.htmlUrl} target="_blank" rel="noreferrer">
                  <ExternalLink className="h-4 w-4" aria-hidden />
                  Open release page
                </a>
              </Button>
            </CardContent>
          </Card>

          {/* Assets */}
          <Card>
            <CardContent className="flex flex-col gap-3 p-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="font-semibold">
                  Assets{' '}
                  <span className="text-sm font-normal text-muted-foreground">
                    ({assets.length} total)
                  </span>
                </h2>
                <div className="flex items-center gap-2">
                  <Label htmlFor="apk-filter" className="text-sm text-muted-foreground">
                    APK only
                  </Label>
                  <Switch
                    id="apk-filter"
                    checked={apkOnly}
                    onCheckedChange={setApkOnly}
                    aria-label="Show APK files only"
                  />
                </div>
              </div>

              {visibleAssets.length === 0 ? (
                <p className="rounded-md bg-muted/60 p-3 text-sm text-muted-foreground">
                  {assets.length === 0
                    ? 'This release has no downloadable assets.'
                    : apkOnly
                      ? `No APK files in this release (${assets.length} assets total). Turn off the filter to see all of them.`
                      : 'No assets to display.'}
                </p>
              ) : (
                <ul className="scrollbar-thin flex max-h-96 flex-col gap-1 overflow-y-auto">
                  {visibleAssets.map((asset) => {
                    const apk = isApkAsset(asset.name)
                    const size = formatSize(asset.size)
                    return (
                      <li
                        key={asset.url}
                        className="flex items-center justify-between gap-3 rounded-md px-2 py-2 hover:bg-muted/60"
                      >
                        <div className="flex min-w-0 items-center gap-2.5">
                          {apk ? (
                            <Smartphone className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                          ) : (
                            <Package className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                          )}
                          <div className="min-w-0">
                            <p className="truncate text-sm font-mono" title={asset.name}>
                              {asset.name}
                            </p>
                            {size && <p className="text-xs text-muted-foreground">{size}</p>}
                          </div>
                        </div>
                        <Button asChild variant="ghost" size="sm" className="shrink-0">
                          <a
                            href={asset.url}
                            target="_blank"
                            rel="noreferrer"
                            download
                            aria-label={`Download ${asset.name}`}
                          >
                            <Download className="h-4 w-4" aria-hidden />
                            <span className="hidden sm:inline">Download</span>
                          </a>
                        </Button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}
