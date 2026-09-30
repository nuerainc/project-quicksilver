import './globals.css'
import type { Metadata, Viewport } from 'next'
import { AppNavigation } from '@/components/app-navigation'

// Render per request so each page gets the CSP nonce middleware.ts sets
// (threat model T-67); a prerendered page would carry no nonce and its
// scripts would be blocked.
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Nuera Quicksilver — Cognitive + Automation Platform',
  description: 'The NQC Kernel, Quicksilver Engine, governed agents, and enterprise workflows.',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-quicksilver-bg text-quicksilver-signal antialiased">
        {(process.env.NEXT_PUBLIC_QUICKSILVER_DEMO_MODE ?? '').trim().toLowerCase() === 'on' && (
          <div role="note" className="border-b border-quicksilver-border bg-quicksilver-panel px-4 py-2 text-center font-mono text-[11px] uppercase tracking-widest text-quicksilver-accent">
            Public demo · synthetic company data only · resets regularly
          </div>
        )}
        <a className="app-skip-link" href="#main-content">Skip to main content</a>
        <AppNavigation />
        <div id="main-content" tabIndex={-1}>
          {children}
        </div>
      </body>
    </html>
  )
}
