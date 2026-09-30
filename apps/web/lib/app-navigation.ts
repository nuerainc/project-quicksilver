export interface AppNavigationLink { href: string; label: string }
export interface AppNavigationGroup { label: string; links: readonly AppNavigationLink[] }

export const APP_NAVIGATION_GROUPS: readonly AppNavigationGroup[] = [
  {
    label: 'Operate',
    links: [
      { href: '/decisions', label: 'Decisions' },
      { href: '/workflows', label: 'Workflows' },
      { href: '/monitoring', label: 'Monitoring' },
    ],
  },
  { label: 'Govern', links: [{ href: '/agents', label: 'Agents' }] },
] as const

export const APP_NAVIGATION_DESTINATIONS = APP_NAVIGATION_GROUPS.flatMap((group) => group.links)

export function activeNavigationRoute(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`)
}
