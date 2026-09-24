import './globals.css'
import type { Metadata } from 'next'

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
