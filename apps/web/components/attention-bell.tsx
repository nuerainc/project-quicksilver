'use client'

import { useEffect, useId, useRef, useState } from 'react'

import { AttentionList } from '@/components/attention-list'
import { useInbox } from '@/components/use-inbox'
import styles from './attention-bell.module.css'

/**
 * The header bell: how many things need the signed-in person, and the list behind it. It shows
 * nothing for a visitor who is not signed in. The count is only what the person can act on; a "+"
 * means a source could not be checked, so the number may be low. It is polled, not live.
 */
export function AttentionBell({ className = '', variant = 'icon' }: { className?: string; variant?: 'icon' | 'row' }) {
  const { inbox, needsSignIn } = useInbox()
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const panelId = useId()

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); buttonRef.current?.focus() } }
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node
      if (!panelRef.current?.contains(target) && !buttonRef.current?.contains(target)) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onPointer)
    panelRef.current?.querySelector<HTMLElement>('button, a[href]')?.focus()
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onPointer) }
  }, [open])

  if (needsSignIn) return null

  const count = inbox?.counts.actionable ?? 0
  const incomplete = inbox ? !inbox.counts.complete : false
  const label = !inbox ? 'What needs you' : count === 0 && !incomplete ? 'What needs you: nothing right now'
    : `What needs you: ${count}${incomplete ? ' or more, some sources could not be checked' : ''} ${count === 1 ? 'item' : 'items'}`
  const showBadge = inbox !== null && (count > 0 || incomplete)

  return (
    <div className={`${styles.wrap} ${className}`.trim()}>
      <button ref={buttonRef} type="button" className={`${styles.bell} ${variant === 'row' ? styles.row : ''}`.trim()} aria-label={label} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => setOpen((current) => !current)}>
        <span aria-hidden="true">🔔︎</span>
        {variant === 'row' && <span className={styles.rowLabel} data-bell-label aria-hidden="true">Needs you</span>}
        {showBadge && <span className={styles.badge} data-incomplete={incomplete} aria-hidden="true">{count > 0 ? `${count}${incomplete ? '+' : ''}` : '!'}</span>}
      </button>
      {open && (
        <div ref={panelRef} id={panelId} className={`${styles.panel} ${variant === 'row' ? styles.panelBeside : ''}`.trim()} role="dialog" aria-label="What needs you">
          <div className={styles.panelHead}>
            <h2>What needs you</h2>
            <button type="button" className={styles.close} onClick={() => { setOpen(false); buttonRef.current?.focus() }}>Close</button>
          </div>
          <AttentionList hideHeading onNavigate={() => setOpen(false)} />
        </div>
      )}
    </div>
  )
}
