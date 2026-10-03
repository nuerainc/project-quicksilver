/** What each permission lets a person do, in the words the page uses. Unknown permissions are shown as they are, never hidden. */
export const PERMISSION_WORDS: Readonly<Record<string, { area: string; can: string }>> = Object.freeze({
  'decision:read': { area: 'Decisions', can: 'See decisions, what needs you, and ask the chat questions.' },
  'decision:propose': { area: 'Decisions', can: 'Ask Quicksilver to plan work, which saves proposals for review.' },
  'decision:approve': { area: 'Decisions', can: 'Approve or reject a decision someone else requested.' },
  'decision:execute': { area: 'Decisions', can: 'Run an approved decision.' },
  'decision:rollback': { area: 'Decisions', can: 'Propose undoing a decision that already ran.' },
  'workflow:read': { area: 'Workflows', can: 'See workflow activity and published versions.' },
  'workflow:publish': { area: 'Workflows', can: 'Review and publish workflow versions.' },
  'agent:review': { area: 'Agents', can: 'Review agent definitions.' },
  'agent:publish': { area: 'Agents', can: 'Publish or roll back agent definitions.' },
  'audit:read': { area: 'Audit', can: 'See traces and alerts, and download a decision’s audit trail.' },
  'finance:read': { area: 'Finance', can: 'See the money ledger.' },
  'run:enqueue': { area: 'Workflows', can: 'Start workflow runs.' },
})

export interface PermissionGroup { area: string; items: Array<{ permission: string; can: string }> }

export function groupPermissions(permissions: readonly string[]): PermissionGroup[] {
  const groups = new Map<string, PermissionGroup>()
  for (const permission of [...permissions].sort()) {
    const known = PERMISSION_WORDS[permission]
    const area = known?.area ?? 'Other'
    const group = groups.get(area) ?? { area, items: [] }
    group.items.push({ permission, can: known?.can ?? 'No description is written for this permission.' })
    groups.set(area, group)
  }
  return [...groups.values()].sort((a, b) => (a.area === 'Other' ? 1 : b.area === 'Other' ? -1 : a.area.localeCompare(b.area)))
}
