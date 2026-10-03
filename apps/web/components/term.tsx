'use client'

import { useId, useState } from 'react'
import { GLOSSARY, type GlossaryTerm } from '@/lib/glossary'

/** A term with its meaning one press away. A button, not a hover tip, so it works by keyboard and on a phone. */
export function Term({ term, children }: { term: GlossaryTerm; children?: string }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <span className="qs-term">
      <button type="button" className="qs-term__button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
        {children ?? term}<span className="qs-term__mark" aria-hidden="true"> ⓘ</span>
        <span className="sr-only"> (what is this?)</span>
      </button>
      {open && <span id={id} role="note" className="qs-term__note">{GLOSSARY[term]}</span>}
    </span>
  )
}
