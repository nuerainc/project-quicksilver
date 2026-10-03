import { appendMoney, moneyTotals, verifyMoneyLedger, type MoneyEntryInput } from '@quicksilver/kernel/playbooks/economics'
import { validateGenesisConfig, type GenesisRunConfig } from '@quicksilver/kernel/playbooks/genesis'
import type { VerifiedWebhookDelivery, WebhookSinkOutcome } from '@quicksilver/kernel/triggers'

import { withLock, type GenesisStore } from './genesis-api.ts'
import { PENDING_PAYMENT_ID, type PendingPaymentEntry, type PendingPaymentStore } from './genesis-store.ts'

/**
 * P-027 (recording side): a Stripe webhook into the Genesis money ledger.
 *
 * This RECORDS payments that already happened in Stripe. It never calls
 * Stripe, never holds a Stripe API key, and never charges, pays, refunds or
 * transfers anything; the only secret it relies on is the webhook signing
 * secret, which the kernel's WebhookTrigger checks (scheme `stripe`) before a
 * delivery reaches this sink. Every response says `executed: false`.
 *
 * What a verified event does depends on the run config:
 *   autoRecordPaymentWebhooks false (default)  a pending row a human confirms
 *                                              (POST /api/genesis/pending-payments/:id/confirm)
 *   autoRecordPaymentWebhooks true             a `revenue` ledger entry, recorded by
 *                                              the `genesis-stripe-webhook` service
 *
 * One payment is recorded once. Stripe sends several events for one payment
 * (a Checkout payment sends `checkout.session.completed` and
 * `payment_intent.succeeded`) and retries each event, so both paths key on the
 * PaymentIntent id: it is the pending row's id and the ledger entry's
 * `source.ref`, and a second event for the same payment is a no-op.
 *
 * Recorded:  payment_intent.succeeded, checkout.session.completed (paid, with a PaymentIntent)
 * Ignored:   test-mode events, unpaid or PaymentIntent-less Checkout sessions,
 *            charge.refunded (see below), and every other event type
 * Invalid:   a malformed event, a non-USD currency, a non-positive amount
 *
 * charge.refunded is deliberately NOT recorded. The ledger's `refund` kind
 * means money coming back to the run (it lowers capital used); a customer
 * refund is money going out, and recording it as `refund` would make the
 * remaining budget look larger. It needs a human until the ledger has a kind
 * for it.
 */

export const STRIPE_WEBHOOK_ACTOR = Object.freeze({ id: 'genesis-stripe-webhook', kind: 'service' as const })

export const RECORDED_STRIPE_EVENTS = Object.freeze(['payment_intent.succeeded', 'checkout.session.completed'] as const)

const MAX_USD = 1_000_000

export type StripeEventMapping =
  | { kind: 'record'; eventId: string; eventType: string; livemode: boolean; paymentRef: string; input: MoneyEntryInput }
  | { kind: 'ignored'; eventId: string; eventType: string; reason: string }
  | { kind: 'invalid'; error: string }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isId = (v: unknown): v is string => typeof v === 'string' && PENDING_PAYMENT_ID.test(v)

/** Pure: a parsed Stripe Event → what the ledger should do with it. */
export function mapStripeEvent(event: unknown): StripeEventMapping {
  if (!isObj(event)) return { kind: 'invalid', error: 'The event must be a JSON object.' }
  if (!isId(event.id)) return { kind: 'invalid', error: 'The event needs an id.' }
  if (typeof event.type !== 'string' || !/^[a-z0-9_.]{1,100}$/.test(event.type)) return { kind: 'invalid', error: 'The event needs a type.' }
  const data = event.data
  if (!isObj(data) || !isObj(data.object)) return { kind: 'invalid', error: 'The event needs data.object.' }
  const eventId = event.id
  const eventType = event.type
  const obj = data.object
  const ignore = (reason: string): StripeEventMapping => ({ kind: 'ignored', eventId, eventType, reason })

  if (eventType === 'charge.refunded') return ignore('Customer refunds are not recorded automatically: the ledger has no kind for money returned to a customer. A human reviews it.')
  if (!(RECORDED_STRIPE_EVENTS as readonly string[]).includes(eventType)) return ignore(`"${eventType}" is not a payment this ledger records.`)
  if (typeof event.livemode !== 'boolean') return { kind: 'invalid', error: 'The event needs livemode.' }

  let paymentRef: unknown
  let cents: unknown
  if (eventType === 'payment_intent.succeeded') {
    paymentRef = obj.id
    cents = obj.amount_received ?? obj.amount
  } else {
    if (obj.payment_status !== 'paid') return ignore('The Checkout session is not paid yet; payment_intent.succeeded records it when it is.')
    paymentRef = isObj(obj.payment_intent) ? obj.payment_intent.id : obj.payment_intent
    if (paymentRef === null || paymentRef === undefined) return ignore('The Checkout session has no PaymentIntent (subscription or setup mode); its payment_intent.succeeded event records the money.')
    cents = obj.amount_total
  }
  if (!isId(paymentRef)) return { kind: 'invalid', error: 'The payment has no valid PaymentIntent id.' }
  if (typeof obj.currency !== 'string' || obj.currency.toLowerCase() !== 'usd') return { kind: 'invalid', error: `Only USD payments are recorded (got "${String(obj.currency)}").` }
  if (typeof cents !== 'number' || !Number.isInteger(cents) || cents <= 0) return { kind: 'invalid', error: 'The amount must be a positive whole number of cents.' }
  const amountUsd = cents / 100
  if (amountUsd > MAX_USD) return { kind: 'invalid', error: `The amount is above $${MAX_USD.toLocaleString('en-US')}.` }
  if (!event.livemode) return ignore('Test-mode event: nothing is recorded in the run ledger.')

  const created = typeof event.created === 'number' && Number.isFinite(event.created) ? new Date(event.created * 1000) : undefined
  return {
    kind: 'record',
    eventId,
    eventType,
    livemode: true,
    paymentRef,
    input: {
      kind: 'revenue',
      amountUsd,
      category: 'sales',
      description: `Stripe payment ${paymentRef} (${eventType}, event ${eventId})`.slice(0, 500),
      source: { type: 'payment-processor', ref: paymentRef },
      ...(created && !Number.isNaN(created.getTime()) ? { occurredAt: created.toISOString() } : {}),
    },
  }
}

export interface GenesisPaymentWebhookDeps {
  config: GenesisRunConfig
  store: GenesisStore
  pending: PendingPaymentStore
  now?: () => number
}

const refused = (status: number, error: string): WebhookSinkOutcome => ({ status, body: { accepted: false, error, executed: false } })

/** A `WebhookEndpoint.deliver` sink for a `genesisPayment` webhook. */
export function genesisPaymentWebhookSink(deps: GenesisPaymentWebhookDeps): (delivery: VerifiedWebhookDelivery) => Promise<WebhookSinkOutcome> {
  const { config, store, pending } = deps
  const now = () => new Date(deps.now?.() ?? Date.now())
  return async (delivery) => {
    const mapped = mapStripeEvent(delivery.payload)
    if (mapped.kind === 'invalid') return refused(422, mapped.error)
    if (mapped.kind === 'ignored') return { status: 200, body: { accepted: true, recorded: false, ignored: true, eventId: mapped.eventId, eventType: mapped.eventType, reason: mapped.reason, executed: false } }
    // 503 makes Stripe retry later, which is right for a fixable host-side problem.
    if (validateGenesisConfig(config).length) return refused(503, 'The Genesis run config is invalid; nothing was recorded.')
    const base = { accepted: true, eventId: mapped.eventId, paymentRef: mapped.paymentRef, executed: false }

    return withLock(config.runId, async () => {
      const s = await store.load(config)
      const existing = s.ledger.entries.find((e) => e.source.type === 'payment-processor' && e.source.ref === mapped.paymentRef)
      if (existing) return { status: 200, body: { ...base, recorded: true, deduplicated: true, seq: existing.seq } }

      if (config.autoRecordPaymentWebhooks !== true) {
        const row: PendingPaymentEntry = {
          id: mapped.paymentRef,
          status: 'pending',
          provider: 'stripe',
          eventId: mapped.eventId,
          eventType: mapped.eventType,
          livemode: mapped.livemode,
          receivedAt: now().toISOString(),
          input: mapped.input,
        }
        const r = await pending.putPending(config.runId, row)
        return { status: r.created ? 202 : 200, body: { ...base, recorded: false, pending: true, status: r.entry.status, deduplicated: !r.created, note: 'Waiting for a human to confirm it into the ledger.' } }
      }

      if (!verifyMoneyLedger(s.ledger).valid) return refused(503, 'The money ledger does not verify; nothing more is recorded until it is reviewed.')
      const r = appendMoney(s.ledger, mapped.input, STRIPE_WEBHOOK_ACTOR, now())
      if (!r.ok) return refused(422, `Not recorded: ${r.reasons.join(' ')}`)
      await store.saveLedger(config.runId, r.ledger)
      return { status: 201, body: { ...base, recorded: true, deduplicated: false, seq: r.entry.seq, totals: moneyTotals(r.ledger) } }
    })
  }
}
