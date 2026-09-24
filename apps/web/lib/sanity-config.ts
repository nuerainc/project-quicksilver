const LEGACY_CHALLENGE_PROJECT_ID = 'd280bqjc'

/** Prevent app requests from reading or mutating the legacy challenge dataset. */
export function getDedicatedSanityProjectId(): string {
  const projectId = process.env.NEXT_PUBLIC_SANITY_PROJECT_ID
  if (!projectId || projectId === LEGACY_CHALLENGE_PROJECT_ID) {
    throw new Error('Configure NEXT_PUBLIC_SANITY_PROJECT_ID with the dedicated Nuera Quicksilver Sanity project. Legacy challenge access is blocked.')
  }
  return projectId
}
