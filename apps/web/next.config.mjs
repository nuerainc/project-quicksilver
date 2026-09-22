import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Next.js only reads env files from this app's directory (apps/web), but the
// documented setup (README / SUBMISSION.md) is ONE `.env` at the repo root.
// Load the root `.env` and `.env.local` too. Variables that are already set —
// real environment variables, or apps/web/.env* which Next has loaded by now —
// win; the root files only fill in what is missing.
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
for (const name of ['.env', '.env.local']) {
  const file = join(rootDir, name)
  if (!existsSync(file)) continue
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!match || match[1].startsWith('#')) continue
    const value = match[2].replace(/^(['"])(.*)\1$/, '$2')
    if (process.env[match[1]] === undefined) process.env[match[1]] = value
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@quicksilver/kernel', '@quicksilver/agent'],
  experimental: {
    // Server actions need this in some configs.
    serverActions: { bodySizeLimit: '2mb' },
  },
}

export default nextConfig
