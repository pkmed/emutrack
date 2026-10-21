'use client'

import { useEffect, useState } from 'react'
import { Download, Smartphone } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'

/**
 * In-app install affordance.
 *
 * The site itself satisfies every Chrome install criterion (verified via the
 * CDP Page.getInstallabilityErrors probe), but Chrome keeps its native entry
 * point easy to miss — the menu item only appears once `beforeinstallprompt`
 * fires, is hidden in a submenu on desktop, and does not exist at all on iOS
 * (WebKit browsers have no install API). This module captures the install
 * event at module scope — it can fire before React mounts — and exposes it
 * as an explicit in-app button that opens the browser's real install dialog,
 * plus honest per-platform guidance when one-click install is unavailable.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

let deferredPrompt: BeforeInstallPromptEvent | null = null
const subscribers = new Set<() => void>()

function notifyAll(): void {
  for (const notify of subscribers) notify()
}

if (typeof window !== 'undefined') {
  // Module scope on purpose: the event may fire before any component mounts.
  window.addEventListener('beforeinstallprompt', (event) => {
    // Suppress the browser's one-shot mini-infobar so the app can present
    // install affordances of its own instead.
    event.preventDefault()
    deferredPrompt = event as BeforeInstallPromptEvent
    notifyAll()
  })
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null
    notifyAll()
  })
}

function currentStandalone(): boolean {
  if (typeof window === 'undefined') return false
  const nav = navigator as Navigator & { standalone?: boolean }
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    nav.standalone === true
  )
}

/** True on iOS/iPadOS, where no browser offers the programmatic install API. */
export function isAppleMobile(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  return (
    /iphone|ipad|ipod/i.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  )
}

/**
 * Reactive install capability: `standalone` when the page already runs as an
 * installed app (install UI must hide), `available` when the browser has
 * signalled that one-click install can be offered right now.
 */
export function useInstallCapability(): { available: boolean; standalone: boolean } {
  const [available, setAvailable] = useState(false)
  const [standalone, setStandalone] = useState(currentStandalone)

  useEffect(() => {
    const notify = () => setAvailable(deferredPrompt !== null)
    subscribers.add(notify)
    notify()
    const mq = window.matchMedia('(display-mode: standalone), (display-mode: fullscreen)')
    const onModeChange = () => setStandalone(currentStandalone())
    mq.addEventListener('change', onModeChange)
    return () => {
      subscribers.delete(notify)
      mq.removeEventListener('change', onModeChange)
    }
  }, [])

  return { available: available && !standalone, standalone }
}

/**
 * Open the browser's native install dialog. Returns the outcome, or
 * 'unavailable' when the browser has not signalled installability.
 */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  if (!deferredPrompt) return 'unavailable'
  await deferredPrompt.prompt()
  const { outcome } = await deferredPrompt.userChoice
  deferredPrompt = null
  notifyAll()
  return outcome
}

/**
 * Slim banner shown on the main screen while the browser offers install and
 * the app is not already running as one. Renders nothing otherwise.
 */
export function InstallBanner() {
  const { available, standalone } = useInstallCapability()
  if (standalone || !available) return null

  return (
    <div className="pt-4">
      <Card className="border-primary/30 bg-primary/5">
        <CardContent className="flex items-center justify-between gap-3 p-4">
          <div className="flex min-w-0 items-center gap-3">
            <Smartphone className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
            <p className="text-sm text-muted-foreground">
              Install EmuTrack on this device — full-screen, works offline, your data stays local.
            </p>
          </div>
          <Button
            size="sm"
            className="shrink-0"
            onClick={() => void promptInstall()}
            aria-label="Install EmuTrack as an app"
          >
            <Download className="h-4 w-4" aria-hidden />
            Install
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
