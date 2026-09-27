import './globals.css'
import type { Metadata } from 'next'

// Render per request so each page gets the CSP nonce middleware.ts sets
// (threat model T-67); a prerendered page would carry no nonce and its
// scripts would be blocked.
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Nuera Quicksilver — Cognitive + Automation Platform',
  description: 'The NQC Kernel, Quicksilver Engine, governed agents, and enterprise workflows.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-quicksilver-bg text-quicksilver-signal antialiased">
        {children}
      </body>
    </html>
  )
}
