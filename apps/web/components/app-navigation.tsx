'use client'

import Link from 'next/link'
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { usePathname } from 'next/navigation'
import { APP_NAVIGATION_GROUPS, activeNavigationRoute } from '@/lib/app-navigation'
import { loadSessionState, signInPageHref, type SessionState } from '@/lib/session-control'
import { AttentionBell } from '@/components/attention-bell'

// Group only destinations that exist today. This gives the shell a task-phase IA
// without implying that the unfinished platform modules are already available.
const SHELL_GROUP_ORDER = ['Operate', 'Build', 'Govern', 'Observe'] as const
const SHELL_ROUTE_GROUP: Record<string, (typeof SHELL_GROUP_ORDER)[number]> = {
  '/': 'Operate',
  '/decisions': 'Operate',
  '/workflows': 'Build',
  '/agents': 'Govern',
  '/entities': 'Govern',
  '/monitoring': 'Observe',
  '/monitoring/traces': 'Observe',
}
const APP_DESTINATIONS = APP_NAVIGATION_GROUPS.flatMap(({ links }) => links)
const NAV_ICONS: Record<string, string> = {
  '/': '⌂',
  '/decisions': '✓',
  '/workflows': '◇',
  '/monitoring': '◷',
  '/monitoring/traces': '≋',
  '/entities': '▦',
  '/agents': '✦',
}

function NavigationGroups({ pathname, mobile = false, collapsed = false, onNavigate }: { pathname: string; mobile?: boolean; collapsed?: boolean; onNavigate?: () => void }) {
  const links = APP_NAVIGATION_GROUPS.flatMap(({ links: groupLinks }) => groupLinks)
  const groups = SHELL_GROUP_ORDER.map((label) => ({
    label,
    links: links.filter(({ href }) => SHELL_ROUTE_GROUP[href] === label),
  })).filter(({ links: groupLinks }) => groupLinks.length > 0)

  return (
    <>
      {groups.map((group) => (
        <section key={group.label} className={mobile ? 'app-nav-group app-nav-group--mobile' : 'app-nav-group'} aria-label={group.label}>
          <h2 className="app-nav-group__title">{group.label}</h2>
          <ul className="app-nav-group__list">
            {group.links.map(({ href, label }) => {
              const active = activeNavigationRoute(pathname, href)
              return (
                <li key={href}>
                  <Link href={href} aria-current={active ? 'page' : undefined} className="app-nav-link" aria-label={collapsed ? label : undefined} title={label} onClick={onNavigate}>
                    <span className="app-nav-link__indicator" aria-hidden="true" />
                    <span className="app-nav-link__icon" aria-hidden="true">{NAV_ICONS[href]}</span>
                    <span className="app-nav-link__label">{label}</span>
                  </Link>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </>
  )
}

function SessionControl({ pathname, mobile = false }: { pathname: string; mobile?: boolean }) {
  const [state, setState] = useState<SessionState>({ status: 'loading' })

  useEffect(() => {
    const controller = new AbortController()
    void loadSessionState((url, init) => fetch(url, init), controller.signal).then((next) => { if (!controller.signal.aborted) setState(next) })
    return () => controller.abort()
  }, [pathname])

  const className = mobile ? 'app-session app-session--mobile' : 'app-session'
  if (state.status === 'loading') return null
  if (state.status === 'unavailable') return <p className={className} role="status">Sign-in unavailable</p>
  if (state.status === 'signed-out') return <a className={`${className} app-session__button`} href={signInPageHref(pathname)}>Sign in</a>
  return (
    <form className={className} method="post" action="/api/auth/logout">
      <Link href="/profile" className="app-session__name" title={`${state.roles.join(', ')} · your account`}>{state.name}</Link>
      <button type="submit" className="app-session__button">Sign out</button>
    </form>
  )
}

export function AppNavigation() {
  const pathname = usePathname() ?? '/'
  const [launcherOpen, setLauncherOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [query, setQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)
  const mobileMenuRef = useRef<HTMLDetailsElement>(null)
  const currentLabel = APP_NAVIGATION_GROUPS.flatMap(({ links }) => links).find(({ href }) => activeNavigationRoute(pathname, href))?.label ?? 'Overview'
  const filteredDestinations = APP_DESTINATIONS.filter(({ label, href }) => `${label} ${href}`.toLowerCase().includes(query.trim().toLowerCase()))

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setLauncherOpen(true)
      }
      if (event.key === 'Escape') setLauncherOpen(false)
    }
    window.addEventListener('keydown', onShortcut)
    return () => window.removeEventListener('keydown', onShortcut)
  }, [])

  useEffect(() => {
    if (launcherOpen) searchInputRef.current?.focus()
    else setQuery('')
  }, [launcherOpen])

  useEffect(() => {
    try { setSidebarCollapsed(window.localStorage.getItem('nuera-quicksilver-sidebar-collapsed') === 'true') } catch { /* Keep the full navigation visible when storage is unavailable. */ }
  }, [])

  function toggleSidebar() {
    setSidebarCollapsed((current) => {
      const next = !current
      try { window.localStorage.setItem('nuera-quicksilver-sidebar-collapsed', String(next)) } catch { /* The control still works for this page view. */ }
      return next
    })
  }

  function openAllWorkspaces() {
    if (mobileMenuRef.current) mobileMenuRef.current.open = true
    mobileMenuRef.current?.querySelector('summary')?.focus()
  }

  function closeMobileMenu() {
    if (mobileMenuRef.current) mobileMenuRef.current.open = false
  }

  function openChat() {
    window.dispatchEvent(new Event('quicksilver:open-chat'))
  }

  function keepLauncherFocus(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Tab') return
    const focusable = event.currentTarget.querySelectorAll<HTMLElement>('button, input:not(:disabled), a[href]')
    if (!focusable.length) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <>
    <header className="app-topbar" data-collapsed={sidebarCollapsed ? 'true' : 'false'}>
      <div className="app-topbar__inner">
        <div className="app-brand-row">
          <Link href="/" className="app-brand" aria-label="Nuera Quicksilver console home">
            <span className="app-brand__mark" aria-hidden="true">NQ</span>
            <span className="app-brand__copy">
              <span className="app-brand__name">Nuera Quicksilver</span>
              <span className="app-brand__tagline">Business operations</span>
            </span>
          </Link>
          <button type="button" className="app-sidebar-collapse" onClick={toggleSidebar} aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-expanded={!sidebarCollapsed} title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
            <span aria-hidden="true">{sidebarCollapsed ? '»' : '«'}</span>
          </button>
        </div>
        <AttentionBell variant="row" className="app-bell app-bell--sidebar" />
        <nav aria-label="Primary navigation" className="app-primary-nav app-primary-nav--desktop">
          <NavigationGroups pathname={pathname} collapsed={sidebarCollapsed} />
        </nav>
        <button type="button" className="app-command-trigger" onClick={() => setLauncherOpen(true)} aria-haspopup="dialog" aria-label="Quick navigate">
          <span className="app-command-icon" aria-hidden="true">⌕</span><span>Quick navigate</span><kbd>Ctrl / ⌘ K</kbd>
        </button>
        <SessionControl pathname={pathname} />
        <AttentionBell className="app-bell app-bell--mobile" />
        <details ref={mobileMenuRef} className="app-mobile-menu">
          <summary className="app-mobile-menu__summary" aria-label={`Open navigation. Current page: ${currentLabel}`}>
            <span className="app-mobile-menu__icon" aria-hidden="true"><span /><span /></span>
            <span className="app-mobile-menu__label">Navigate</span>
            <span className="app-mobile-menu__current">{currentLabel}</span>
            <span className="app-mobile-menu__chevron" aria-hidden="true" />
          </summary>
          <nav aria-label="Mobile navigation" className="app-mobile-menu__panel">
            <NavigationGroups pathname={pathname} mobile onNavigate={closeMobileMenu} />
            <button type="button" className="app-command-trigger app-command-trigger--mobile" onClick={() => setLauncherOpen(true)} aria-haspopup="dialog">
              <span className="app-command-icon" aria-hidden="true">⌕</span><span>Quick navigate</span><kbd>Ctrl / ⌘ K</kbd>
            </button>
            <SessionControl pathname={pathname} mobile />
          </nav>
        </details>
      </div>
      </header>
      <nav aria-label="Mobile quick navigation" className="app-bottom-nav">
        <Link href="/" aria-current={pathname === '/' ? 'page' : undefined}><span aria-hidden="true">⌂</span><span>Home</span></Link>
        <Link href="/decisions" aria-current={activeNavigationRoute(pathname, '/decisions') ? 'page' : undefined}><span aria-hidden="true">✓</span><span>Decisions</span></Link>
        <Link href="/workflows" aria-current={activeNavigationRoute(pathname, '/workflows') ? 'page' : undefined}><span aria-hidden="true">◇</span><span>Workflows</span></Link>
        <button type="button" onClick={openChat}><span aria-hidden="true">✦</span><span>Chat</span></button>
        <button type="button" onClick={openAllWorkspaces} aria-label="Open all workspaces"><span aria-hidden="true">☰</span><span>More</span></button>
      </nav>
      {launcherOpen && (
        <div className="app-command-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setLauncherOpen(false) }}>
          <div className="app-command-dialog" role="dialog" aria-modal="true" aria-labelledby="app-command-title" onKeyDown={keepLauncherFocus}>
            <div className="app-command-heading">
              <h2 id="app-command-title">Go to a workspace</h2>
              <button type="button" className="app-command-close" onClick={() => setLauncherOpen(false)} aria-label="Close quick navigation">Esc</button>
            </div>
            <label className="app-command-search-label" htmlFor="app-command-search">Search workspaces</label>
            <input
              ref={searchInputRef}
              id="app-command-search"
              className="app-command-search"
              type="search"
              placeholder="Search by name or route…"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
            <nav aria-label="Quick navigation results" className="app-command-results">
              {filteredDestinations.length ? filteredDestinations.map(({ href, label }) => (
                <Link key={href} href={href} aria-current={activeNavigationRoute(pathname, href) ? 'page' : undefined} onClick={() => setLauncherOpen(false)}>
                  <span>{label}</span><span className="app-command-route">{href}</span><span aria-hidden="true">↗</span>
                </Link>
              )) : <p className="app-command-empty">No available workspace matches that search.</p>}
            </nav>
            <p className="app-command-hint">Press <kbd>Esc</kbd> to close</p>
          </div>
        </div>
      )}
    </>
  )
}
