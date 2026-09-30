import { NextResponse } from 'next/server'
import { getSanityClient } from '@/lib/sanity-client'
import { guardWebRoute } from '@/lib/route-guard'
import { publicationRefusal } from '@/lib/workflow-publication-http'

export const dynamic = 'force-dynamic'

const ENTITY_DIRECTORY_QUERY = `{
  "total": count(*[_type == "entity"]),
  "entities": *[_type == "entity"] | order(name asc)[0...500]{
    "id": _id,
    name,
    entityType,
    availability,
    riskProfile,
    costProfile,
    "department": department->name,
    "reportsTo": reportsTo->{"id": _id, name},
    "capabilities": capabilities[]->{"id": _id, name}
  }
}`

/** Authenticated read-only directory; record edits remain in governed Sanity Studio. */
export async function GET(request: Request) {
  const caller = await guardWebRoute(request, 'entities')
  if (!caller.ok) return publicationRefusal(caller)

  try {
    const directory = await getSanityClient('read').fetch<{
      total: number
      entities: Array<{
        id: string
        name: string
        entityType: string
        availability?: string | null
        riskProfile?: number | null
        costProfile?: string | null
        department?: string | null
        reportsTo?: { id: string; name: string } | null
        capabilities?: Array<{ id: string; name: string }>
      }>
    }>(ENTITY_DIRECTORY_QUERY)
    return NextResponse.json(directory, { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    console.error('[entities] directory load failed', error instanceof Error ? error.name : 'UnknownError')
    return NextResponse.json({ error: 'Could not load the company directory. Check the configured Quicksilver read data source.' }, { status: 503, headers: { 'cache-control': 'no-store' } })
  }
}
