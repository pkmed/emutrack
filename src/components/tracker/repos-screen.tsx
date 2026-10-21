'use client'

import { useState } from 'react'
import { ArrowLeft, Pencil, Plus, Trash2 } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { parseRepoUrl, repoKey } from '@/lib/tracker/sources'
import { newId, type TrackedRepo } from '@/lib/tracker/types'

/** New or edited repository fields; existing check state is preserved by the caller. */
export interface RepoDraft {
  id: string
  name: string
  url: string
  relay: boolean
}

interface ReposScreenProps {
  repos: TrackedRepo[]
  onBack: () => void
  onSave: (draft: RepoDraft) => Promise<void>
  onDelete: (id: string) => Promise<void>
}

interface FormState {
  id: string | null
  name: string
  url: string
  relay: boolean
}

export function ReposScreen({ repos, onBack, onSave, onDelete }: ReposScreenProps) {
  const [form, setForm] = useState<FormState | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<TrackedRepo | null>(null)
  const [saving, setSaving] = useState(false)

  const openAdd = () => setForm({ id: null, name: '', url: '', relay: false })
  const openEdit = (repo: TrackedRepo) =>
    setForm({ id: repo.id, name: repo.name, url: repo.url, relay: repo.relay === true })
  const closeForm = () => setForm(null)

  const parsed = form ? parseRepoUrl(form.url) : null
  const duplicateKey = form
    ? repos.find((r) => r.id !== form.id && repoKey(r.url) === repoKey(form.url))?.name ?? null
    : null

  const urlError =
    form && form.url.trim().length > 0
      ? !parsed
        ? 'Unrecognized repository URL. Use something like https://github.com/owner/repo/releases'
        : duplicateKey
          ? `This URL is already tracked as "${duplicateKey}".`
          : null
      : null
  const canSave = Boolean(form && form.name.trim() && parsed && !duplicateKey && !saving)

  const submit = async () => {
    if (!form || !parsed) return
    setSaving(true)
    try {
      await onSave({
        id: form.id ?? newId(),
        name: form.name.trim(),
        url: form.url.trim(),
        relay: form.relay,
      })
      closeForm()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="py-4">
      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back to main screen">
            <ArrowLeft className="h-5 w-5" aria-hidden />
          </Button>
          <h1 className="text-lg font-semibold">Repositories</h1>
        </div>
        <Button size="sm" onClick={openAdd}>
          <Plus className="h-4 w-4" aria-hidden />
          Add
        </Button>
      </div>

      {repos.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            No repositories yet. Add one to start tracking releases.
          </CardContent>
        </Card>
      ) : (
        <ul className="flex flex-col gap-3" aria-label="Configured repositories">
          {repos.map((repo) => (
            <li key={repo.id}>
              <Card>
                <CardContent className="flex items-start justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{repo.name}</p>
                    <a
                      href={repo.url}
                      target="_blank"
                      rel="noreferrer"
                      className="block truncate font-mono text-xs text-muted-foreground underline-offset-2 hover:underline"
                      title={repo.url}
                    >
                      {repo.url}
                    </a>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button variant="ghost" size="icon" onClick={() => openEdit(repo)} aria-label={`Edit ${repo.name}`}>
                      <Pencil className="h-4 w-4" aria-hidden />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-destructive hover:text-destructive"
                      onClick={() => setDeleteTarget(repo)}
                      aria-label={`Delete ${repo.name}`}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {/* Add / edit form */}
      <Dialog open={form !== null} onOpenChange={(open) => !open && closeForm()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{form?.id ? 'Edit repository' : 'Add repository'}</DialogTitle>
            <DialogDescription>
              Point to a GitHub releases page, for example https://github.com/owner/repo/releases
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid gap-2">
              <Label htmlFor="repo-name">Repository name</Label>
              <Input
                id="repo-name"
                value={form?.name ?? ''}
                onChange={(e) => setForm((f) => (f ? { ...f, name: e.target.value } : f))}
                placeholder="mGBA"
                autoFocus
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="repo-url">Repository release page URL</Label>
              <Input
                id="repo-url"
                value={form?.url ?? ''}
                onChange={(e) => setForm((f) => (f ? { ...f, url: e.target.value } : f))}
                placeholder="https://github.com/mgba-emu/mgba/releases"
                inputMode="url"
                aria-invalid={Boolean(urlError)}
              />
              {urlError ? (
                <p className="text-sm text-destructive">{urlError}</p>
              ) : parsed ? (
                <p className="text-xs text-muted-foreground">
                  Detected: {parsed.owner}/{parsed.repo}
                </p>
              ) : null}
            </div>
            <div className="grid gap-2">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="repo-relay"
                  checked={form?.relay ?? false}
                  onCheckedChange={(v) => setForm((f) => (f ? { ...f, relay: v === true } : f))}
                />
                <Label
                  htmlFor="repo-relay"
                  className="text-sm font-normal leading-none"
                >
                  Fetch via ScraperAPI
                </Label>
              </div>
              <p className="text-xs text-muted-foreground">
                Only for servers that block browser access (no CORS headers), e.g. self-hosted
                Forgejo/Gitea. Requires a ScraperAPI API key — set it in Settings (3-dot menu).
                Each lookup through the proxy uses API credits — use with public repositories
                only.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeForm}>
              Close
            </Button>
            <Button onClick={submit} disabled={!canSave}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete repository?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget
                ? `"${deleteTarget.name}" and its acknowledged version will be removed from this device. This cannot be undone.`
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={async () => {
                if (deleteTarget) await onDelete(deleteTarget.id)
                setDeleteTarget(null)
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
