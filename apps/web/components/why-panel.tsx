import type { DecisionWhy } from '@quicksilver/kernel'

const BAND_TEXT: Record<DecisionWhy['risk']['band'], string> = {
  'within-autonomous-ceiling': 'within the autonomous ceiling',
  'needs-approval': 'above the autonomous ceiling: a human must approve',
  'above-review-ceiling': 'above the review ceiling: a human must approve',
}

const GUARD_MARK: Record<string, string> = { applies: '●', superseded: '↷', conflicts: '≠', inapplicable: '○' }

/**
 * Why the kernel decided what it did: the risk arithmetic, the policy rows that
 * fired, the policy revision in force, and what would have changed the answer.
 * Everything shown is the kernel's own output (see `explainWhy`).
 */
export function WhyPanel({ why, escalationReasons = [] }: { why: DecisionWhy; escalationReasons?: string[] }) {
  const { risk } = why
  const improving = why.whatWouldChangeIt
  return (
    <details open={why.recommendation === 'reject'} className="rounded border border-quicksilver-border bg-quicksilver-bg p-3" data-testid="why-panel">
      <summary className="flex min-h-11 cursor-pointer items-center font-mono text-xs uppercase tracking-widest text-quicksilver-accent">
        Why this decision
      </summary>
      <div className="mt-2 space-y-4">
        <p className="font-mono text-sm text-quicksilver-signal">{why.headline}</p>

        {escalationReasons.length > 0 && (
          <ul className="space-y-1">
            {escalationReasons.map((reason) => (
              <li key={reason} className="font-mono text-xs text-yellow-300">! Evaluator: {reason}</li>
            ))}
          </ul>
        )}

        <section aria-label="Risk arithmetic">
          <h4 className="font-mono text-xs uppercase tracking-widest text-quicksilver-accent">Risk arithmetic</h4>
          <table className="mt-1 w-full font-mono text-xs text-quicksilver-signal">
            <tbody>
              {risk.lines.map((line) => (
                <tr key={line.label}>
                  <td className="py-0.5 pr-3">{line.label}{line.note ? <span className="text-quicksilver-accent"> ({line.note})</span> : null}</td>
                  <td className="py-0.5 text-right">+{line.value}</td>
                </tr>
              ))}
              <tr className="border-t border-quicksilver-border">
                <td className="py-0.5 pr-3">Before the capability graph multiplier</td>
                <td className="py-0.5 text-right">{risk.preMultiplierRisk}</td>
              </tr>
              {risk.multiplier !== 1 && (
                <tr>
                  <td className="py-0.5 pr-3">Capability graph multiplier</td>
                  <td className="py-0.5 text-right">×{risk.multiplier}</td>
                </tr>
              )}
              <tr className="border-t border-quicksilver-border font-semibold">
                <td className="py-0.5 pr-3">Final risk</td>
                <td className="py-0.5 text-right">{risk.finalRisk}</td>
              </tr>
            </tbody>
          </table>
          <p className="mt-1 font-mono text-xs text-quicksilver-signal">
            Ceilings: autonomous up to {risk.autoMax}, review up to {risk.review}. Risk {risk.finalRisk} is {BAND_TEXT[risk.band]}.
          </p>
        </section>

        {why.blockingReasons.length > 0 && (
          <section aria-label="Refusal reasons">
            <h4 className="font-mono text-xs uppercase tracking-widest text-quicksilver-accent">Refused because</h4>
            <ul className="mt-1 space-y-1">
              {why.blockingReasons.map((reason) => (
                <li key={reason} className="font-mono text-xs text-red-400">✗ {reason}</li>
              ))}
            </ul>
          </section>
        )}

        {why.recommendation === 'request-approval' && why.approvalDrivers.length > 0 && (
          <section aria-label="Why a human is needed">
            <h4 className="font-mono text-xs uppercase tracking-widest text-quicksilver-accent">A human is needed because</h4>
            <ul className="mt-1 space-y-1">
              {why.approvalDrivers.map((reason) => (
                <li key={reason} className="font-mono text-xs text-yellow-300">! {reason}</li>
              ))}
            </ul>
          </section>
        )}

        <section aria-label="What would change the answer">
          <h4 className="font-mono text-xs uppercase tracking-widest text-quicksilver-accent">What would change the answer</h4>
          {improving.length === 0 ? (
            <p className="mt-1 font-mono text-xs text-quicksilver-signal">
              {why.recommendation === 'execute-autonomously' ? 'Nothing: this already runs on its own.' : 'No single change found that improves the outcome.'}
            </p>
          ) : (
            <ul className="mt-1 space-y-1">
              {improving.map((c) => (
                <li key={c.change} className="font-mono text-xs text-quicksilver-signal">
                  → {c.change}{' '}
                  <span className="text-quicksilver-accent">
                    {c.simulated && c.outcome
                      ? `The kernel then says ${c.outcome.recommendation} at risk ${c.outcome.riskLevel}.`
                      : 'Required; the kernel cannot try this on its own.'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-label="Policy guards">
          <h4 className="font-mono text-xs uppercase tracking-widest text-quicksilver-accent">Policy guards that fired</h4>
          {why.guards.length === 0 ? (
            <p className="mt-1 font-mono text-xs text-quicksilver-signal">No policy was in scope for this action.</p>
          ) : (
            <ul className="mt-1 space-y-1">
              {why.guards.map((guard) => (
                <li key={`${guard.policyId}:${guard.result}`} className="font-mono text-xs text-quicksilver-signal">
                  {GUARD_MARK[guard.result] ?? '·'} {guard.policyName} <span className="text-quicksilver-accent">{guard.result}{guard.reasonCode ? ` (${guard.reasonCode})` : ''}</span>: {guard.reason}
                  {!guard.citedByPlanner && guard.result === 'applies' ? <span className="text-yellow-300"> — the planner did not cite it</span> : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        {why.capability && (
          <section aria-label="Capability graph">
            <h4 className="font-mono text-xs uppercase tracking-widest text-quicksilver-accent">Capability graph</h4>
            <p className="mt-1 font-mono text-xs text-quicksilver-signal">
              Governing scopes: {why.capability.effectiveScopes.join(', ') || 'none'}.
              {why.capability.inheritedFrom.length > 0 ? ` Inherited from ${why.capability.inheritedFrom.join(', ')}.` : ''}
              {' '}Effective base risk {why.capability.baseRiskLevel}.
            </p>
          </section>
        )}

        <p className="break-all font-mono text-xs text-quicksilver-accent">Policy revision in force: {why.policySnapshot}</p>
      </div>
    </details>
  )
}
