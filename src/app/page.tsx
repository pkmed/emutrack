import EmuTrackApp from '@/components/tracker/app'
import { RegisterServiceWorker } from '@/components/pwa/register-sw'

export default function Home() {
  return (
    <>
      <RegisterServiceWorker />
      <EmuTrackApp />
    </>
  )
}
