'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { APP_NAVIGATION_DESTINATIONS, APP_NAVIGATION_GROUPS, activeNavigationRoute } from '@/lib/app-navigation'

export function AppNavigation() {
  const pathname = usePathname() ?? '/'

  return (
    <header className="app-topbar">
      <div className="app-topbar__inner">
        <Link href="/" className="app-brand" aria-label="Nuera Quicksilver console home">
          <span className="app-brand__name">Nuera Quicksilver</span>
          <span className="app-brand__tagline">NQC Kernel · Cognitive + automation</span>
        </Link>
        <nav aria-label="Primary navigation" className="app-primary-nav app-primary-nav--desktop">
          <ul className="app-primary-nav__list">
            {APP_NAVIGATION_DESTINATIONS.map(({ href, label }) => {
              const active = activeNavigationRoute(pathname, href)
              return (
                <li key={href}>
                  <Link href={href} aria-current={active ? 'page' : undefined} className="app-primary-nav__link">
                    {label}
                  </Link>
                </li>
              )
            })}
          </ul>
        </nav>
        <details className="app-mobile-menu">
          <summary className="app-mobile-menu__summary">
            <span>Menu</span>
            <span className="app-mobile-menu__current">{APP_NAVIGATION_DESTINATIONS.find(({ href }) => activeNavigationRoute(pathname, href))?.label ?? 'Console'}</span>
          </summary>
          <nav aria-label="Mobile navigation" className="app-mobile-menu__panel">
            {APP_NAVIGATION_GROUPS.map((group) => (
              <section key={group.label} className="app-mobile-menu__group" aria-label={group.label}>
                <h2>{group.label}</h2>
                <ul>
                  {group.links.map(({ href, label }) => {
                    const active = activeNavigationRoute(pathname, href)
                    return <li key={href}><Link href={href} aria-current={active ? 'page' : undefined} className="app-primary-nav__link">{label}</Link></li>
                  })}
                </ul>
              </section>
            ))}
          </nav>
        </details>
      </div>
    </header>
  )
}
