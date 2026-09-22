import './globals.css'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Quicksilver — Autonomous Company OS',
  description: 'Structured organizational knowledge. Agent reasoning. Deterministic authority.',
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