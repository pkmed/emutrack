'use client'

import { useState } from 'react'
import { ArrowLeft, Download, Eye, EyeOff, ExternalLink, KeyRound, Loader2, Upload } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { isAppleMobile, promptInstall, useInstallCapability } from '@/components/pwa/install-button'
import { testScraperApiKey } from '@/lib/tracker/sources'
import { loadScraperApiKey, saveScraperApiKey } from '@/lib/tracker/settings'

interface SettingsScreenProps {
  onBack: () => void
  onExport: () => void
  onImport: () => void
}

/**
 * Settings screen, opened from the header's 3-dot button.
 *
 * Contains the two global configuration areas:
 *  - ScraperAPI access: the device-local API key used by repositories with
 *    "Fetch via ScraperAPI" enabled. The key intentionally lives outside the
 *    app bundle and outside exported configuration files.
 *  - Data: configuration export/import (moved here from the former
 *    dropdown menu).
 */
export function SettingsScreen({ onBack, onExport, onImport }: SettingsScreenProps) {
  const [key, setKey] = useState(() => loadScraperApiKey())
  const [showKey, setShowKey] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)
  const [testError, setTestError] = useState<string | null>(null)
  const { available: installAvailable, standalone } = useInstallCapability()

  const saved = key.trim().length > 0

  const saveKey = () => {
    saveScraperApiKey(key)
    toast.success(saved ? 'ScraperAPI key saved on this device' : 'ScraperAPI key cleared')
  }

  const runTest = async () => {
    setTesting(true)
    setTestResult(null)
    setTestError(null)
    try {
      const message = await testScraperApiKey(key)
      setTestResult(message)
    } catch (err) {
      setTestError(err instanceof Error ? err.message : String(err))
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="py-4">
      <div className="mb-4 flex items-center gap-1">
        <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back to main screen">
          <ArrowLeft className="h-5 w-5" aria-hidden />
        </Button>
        <h1 className="text-lg font-semibold">Settings</h1>
      </div>

      <div className="flex flex-col gap-4">
        {/* ----------------------------- Install ----------------------------- */}
        <Card>
          <CardContent className="flex flex-col gap-3 p-4">
            <div className="flex items-center gap-2">
              <Download className="h-4 w-4 text-muted-foreground" aria-hidden />
              <h2 className="font-medium">Install app</h2>
            </div>
            {standalone ? (
              <p className="text-sm text-muted-foreground" role="status">
                You are running the installed app.
              </p>
            ) : installAvailable ? (
              <>
                <p className="text-sm text-muted-foreground">
                  Install EmuTrack on this device for a full-screen, offline-capable app window.
                </p>
                <div>
                  <Button size="sm" onClick={() => void promptInstall()}>
                    <Download className="h-4 w-4" aria-hidden />
                    Install app
                  </Button>
                </div>
              </>
            ) : isAppleMobile() ? (
              <p className="text-sm text-muted-foreground">
                Browsers on iPhone/iPad don’t offer one-click install. Open this page in{' '}
                <span className="text-foreground">Safari</span>, tap the{' '}
                <span className="text-foreground">Share</span> button and choose{' '}
                <span className="text-foreground">“Add to Home Screen”</span>.
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                This browser hasn’t offered one-click install yet. Try the browser menu —
                “Install page as app” (Chrome desktop: under “Cast, save and share”) or “Add to
                Home screen” (Android) — or reload the page and check again.
              </p>
            )}
          </CardContent>
        </Card>

        {/* ------------------------- ScraperAPI key ------------------------- */}
        <Card>
          <CardContent className="flex flex-col gap-3 p-4">
            <div className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-muted-foreground" aria-hidden />
              <h2 className="font-medium">ScraperAPI</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              Used by repositories with <span className="text-foreground">“Fetch via ScraperAPI”</span>{' '}
              enabled — servers that block browser access (no CORS headers), e.g. self-hosted
              Forgejo/Gitea. Get a free key at{' '}
              <a
                href="https://dashboard.scraperapi.com/"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-0.5 underline underline-offset-2 hover:underline"
              >
                dashboard.scraperapi.com
                <ExternalLink className="h-3 w-3" aria-hidden />
              </a>
              .
            </p>

            <div className="grid gap-2">
              <Label htmlFor="scraper-key">API key</Label>
              <div className="flex gap-2">
                <Input
                  id="scraper-key"
                  type={showKey ? 'text' : 'password'}
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder="paste your ScraperAPI key"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => setShowKey((v) => !v)}
                  aria-label={showKey ? 'Hide API key' : 'Show API key'}
                >
                  {showKey ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Stored only in this browser (never in the app bundle or exported configuration
                files). Each release check through ScraperAPI uses 1 API credit of your account.
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={saveKey}>
                Save key
              </Button>
              <Button size="sm" variant="outline" onClick={() => void runTest()} disabled={testing || !saved}>
                {testing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                Test key
              </Button>
            </div>
            {testResult ? (
              <p className="text-sm text-emerald-600 dark:text-emerald-400" role="status">
                {testResult}
              </p>
            ) : null}
            {testError ? (
              <p className="text-sm text-destructive" role="alert">
                {testError}
              </p>
            ) : null}
          </CardContent>
        </Card>

        {/* ----------------------------- Data ------------------------------ */}
        <Card>
          <CardContent className="flex flex-col gap-3 p-4">
            <h2 className="font-medium">Data</h2>
            <p className="text-sm text-muted-foreground">
              Export saves every repository with its acknowledged version to a JSON file. Import
              restores or merges a previously exported file. All data stays on this device.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button variant="outline" onClick={onExport} className="w-full sm:w-auto">
                <Download className="h-4 w-4" aria-hidden />
                Export configuration
              </Button>
              <Button variant="outline" onClick={onImport} className="w-full sm:w-auto">
                <Upload className="h-4 w-4" aria-hidden />
                Import configuration
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
