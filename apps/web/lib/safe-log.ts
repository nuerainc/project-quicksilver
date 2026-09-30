/** Return only an allowlisted error class; exception messages may contain credentials or request data. */
export function safeErrorName(error: unknown): string {
  if (!(error instanceof Error)) return 'UnknownError'
  return /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(error.name) ? error.name : 'UnknownError'
}
