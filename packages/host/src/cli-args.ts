/** Shared, dependency-free parsing for the host package's command-line tools. */
export interface ParsedCommandArgs {
  command: string | undefined
  args: string[]
  positional: string[]
  flag(name: string): string | undefined
}

export const CLI_VALUE_FLAGS = Object.freeze({
  onboard: [] as const,
  genesis: ['--source', '--experiment', '--channel', '--proposer'] as const,
  operate: ['--source', '--experiment', '--cash'] as const,
  tasks: ['--capability', '--department', '--key', '--status'] as const,
  whatif: ['--run', '--horizon', '--runs', '--seed', '--cash', '--scenario', '--period-days', '--reserve', '--block', '--noise', '--department'] as const,
})

/**
 * Parse the existing CLI convention: the first token is the command, `--name`
 * tokens are flags, and selected flags consume the following token as a value.
 * `skipValueAfterAnyFlag` preserves onboard's historical behavior; Genesis
 * explicitly lists its value-taking flags so positional text after switches
 * such as `--confirm` stays positional.
 */
export function parseCommandArgs(
  argv: readonly string[],
  options: { valueFlags?: readonly string[]; skipValueAfterAnyFlag?: boolean } = {},
): ParsedCommandArgs {
  const [command, ...args] = argv
  const valueFlags = new Set(options.valueFlags ?? [])
  const positional = args.filter((value, index) => {
    if (value.startsWith('--')) return false
    const previous = args[index - 1]
    return !(index > 0 && (options.skipValueAfterAnyFlag ? previous?.startsWith('--') : valueFlags.has(previous ?? '')))
  })

  return {
    command,
    args,
    positional,
    flag(name) {
      const index = args.indexOf(name)
      const value = index >= 0 ? args[index + 1] : undefined
      return value && !value.startsWith('--') ? value : undefined
    },
  }
}
