'use client'

import { useEffect } from 'react'

/**
 * Registers the service worker that makes the app shell available offline.
 * Silent no-op when the browser does not support service workers.
 *
 * The script URL is relative to the page so registration works both at a
 * domain root and on a sub-path deployment (e.g. GitHub Pages project sites).
 */
export function RegisterServiceWorker() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
    const register = () => {
      navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => {
        // Offline support is best-effort; never block the app on SW errors.
      })
    }
    if (document.readyState === 'complete') {
      register()
    } else {
      window.addEventListener('load', register)
      return () => window.removeEventListener('load', register)
    }
  }, [])

  return null
}
