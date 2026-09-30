/** Resolve the dedicated Sanity project for Studio builds. */
export function dedicatedSanityProjectId(
  studioProjectId: string | undefined = process.env.SANITY_STUDIO_PROJECT_ID,
  publicProjectId: string | undefined = process.env.NEXT_PUBLIC_SANITY_PROJECT_ID,
): string {
  const projectId = studioProjectId?.trim() || publicProjectId?.trim()
  if (!projectId || projectId === 'd280bqjc') {
    throw new Error(
      'SANITY_STUDIO_PROJECT_ID or NEXT_PUBLIC_SANITY_PROJECT_ID must identify the dedicated Nuera Quicksilver Sanity project; legacy challenge access is blocked.',
    )
  }
  return projectId
}
