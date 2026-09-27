/**
 * Who may talk to the operator. Deny by default: a sender is heard only once
 * paired. The owner creates a one-time pairing code (8 characters, valid one
 * hour) for a person; that person sends the code to the bot from any channel,
 * and from then on that channel identity belongs to them. One person can pair
 * several channels, and all of them share one conversation and one memory.
 *
 * Wrong codes are rate-limited per sender (the kernel's token bucket), and a
 * code works once.
 */
import { randomInt } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { TokenBucketLimiter } from '@quicksilver/kernel/rate-limit'

export interface Person {
  /** A principal id (for example the Sanity entity id). */
  id: string
  name: string
  /** May approve the operator's calls from a chat. */
  canApprove: boolean
}

export interface PairingState {
  people: Person[]
  /** `${channel}:${senderId}` → person id */
  identities: Record<string, string>
  codes: Array<{ code: string; personId: string; expiresAt: string }>
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O, 1/I

export function newPairingCode(): string {
  let s = ''
  for (let i = 0; i < 8; i++) s += ALPHABET[randomInt(ALPHABET.length)]
  return s
}

export class PairingRegistry {
  private readonly path: string
  private state: PairingState | undefined
  private readonly attempts = new TokenBucketLimiter({ burst: 5, perMinute: 2 })
  private readonly now: () => Date

  constructor(path: string, now: () => Date = () => new Date()) { this.path = path; this.now = now }

  private async load(): Promise<PairingState> {
    if (!this.state) {
      try { this.state = JSON.parse(await readFile(this.path, 'utf8')) as PairingState } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
        this.state = { people: [], identities: {}, codes: [] }
      }
    }
    return this.state
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    await writeFile(`${this.path}.tmp`, JSON.stringify(this.state, null, 1), { mode: 0o600 })
    await rename(`${this.path}.tmp`, this.path)
  }

  async addPerson(p: Person): Promise<void> {
    const s = await this.load()
    s.people = [...s.people.filter((x) => x.id !== p.id), p]
    await this.save()
  }

  async createCode(personId: string, ttlMinutes = 60): Promise<string> {
    const s = await this.load()
    if (!s.people.some((p) => p.id === personId)) throw new Error(`Unknown person "${personId}". Add them first.`)
    const code = newPairingCode()
    const now = this.now().getTime()
    s.codes = [...s.codes.filter((c) => Date.parse(c.expiresAt) > now), { code, personId, expiresAt: new Date(now + ttlMinutes * 60_000).toISOString() }]
    await this.save()
    return code
  }

  /** The person a channel identity belongs to, or undefined (not paired: ignore). */
  async who(channel: string, senderId: string): Promise<Person | undefined> {
    const s = await this.load()
    const id = s.identities[`${channel}:${senderId}`]
    return id ? s.people.find((p) => p.id === id) : undefined
  }

  /** An unpaired sender sent some text: pair them if it is a valid code. */
  async tryPair(channel: string, senderId: string, text: string): Promise<{ paired: Person } | { paired: null; reason: 'not-a-code' | 'rate-limited' | 'invalid' }> {
    const candidate = text.trim().toUpperCase().replace(/\s+/g, '')
    if (!/^[A-Z2-9]{8}$/.test(candidate)) return { paired: null, reason: 'not-a-code' }
    if (!this.attempts.take(`${channel}:${senderId}`).ok) return { paired: null, reason: 'rate-limited' }
    const s = await this.load()
    const now = this.now().getTime()
    const hit = s.codes.find((c) => c.code === candidate && Date.parse(c.expiresAt) > now)
    if (!hit) return { paired: null, reason: 'invalid' }
    s.codes = s.codes.filter((c) => c !== hit)
    s.identities[`${channel}:${senderId}`] = hit.personId
    await this.save()
    return { paired: s.people.find((p) => p.id === hit.personId)! }
  }

  async unpair(channel: string, senderId: string): Promise<boolean> {
    const s = await this.load()
    const key = `${channel}:${senderId}`
    if (!(key in s.identities)) return false
    delete s.identities[key]
    await this.save()
    return true
  }

  async list(): Promise<PairingState> { return structuredClone(await this.load()) }
}
