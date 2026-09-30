import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CLI_VALUE_FLAGS, parseCommandArgs } from './cli-args.ts'

test('Genesis parsing keeps flag values out of positional arguments and reads them by name', () => {
  const parsed = parseCommandArgs(
    ['spend', '12.50', 'software', 'renewal', '--source', 'invoice:Q-1', '--experiment', 'exp-1', '--confirm'],
    { valueFlags: ['--source', '--experiment'] },
  )
  assert.equal(parsed.command, 'spend')
  assert.deepEqual(parsed.positional, ['12.50', 'software', 'renewal'])
  assert.equal(parsed.flag('--source'), 'invoice:Q-1')
  assert.equal(parsed.flag('--experiment'), 'exp-1')
  assert.equal(parsed.flag('--confirm'), undefined)
})

test('Onboard parsing preserves its historical rule for values after any flag', () => {
  const parsed = parseCommandArgs(['recommend', 'intent-1', 'sales', 'Draft a follow-up', '--risk', '3'], {
    skipValueAfterAnyFlag: true,
  })
  assert.equal(parsed.command, 'recommend')
  assert.deepEqual(parsed.positional, ['intent-1', 'sales', 'Draft a follow-up'])
  assert.equal(parsed.flag('--risk'), '3')
})

test('a missing flag value does not consume the next option', () => {
  const parsed = parseCommandArgs(['check-content', 'message.txt', '--proposer', '--verbose'], {
    valueFlags: CLI_VALUE_FLAGS.genesis,
  })
  assert.deepEqual(parsed.positional, ['message.txt'])
  assert.equal(parsed.flag('--proposer'), undefined)
  assert.equal(parsed.flag('--missing'), undefined)
})

test('production CLI flag profiles retain the command, positionals, and each expected value', () => {
  const cases = [
    { name: 'Operate', values: CLI_VALUE_FLAGS.operate, argv: ['spend', '12.50', 'software', 'renewal', '--source', 'bank:invoice', '--experiment', 'exp-3', '--confirm'], expected: ['12.50', 'software', 'renewal'] },
    { name: 'Tasks', values: CLI_VALUE_FLAGS.tasks, argv: ['submit', 'Review quarterly plan', '--capability', 'tasks:submit', '--department', 'finance', '--key', 'request-9'], expected: ['Review quarterly plan'] },
    { name: 'What-if', values: CLI_VALUE_FLAGS.whatif, argv: ['cash', '--run', 'operate', '--cash', '1000', '--horizon', '6'], expected: [] },
  ] as const
  for (const example of cases) {
    const parsed = parseCommandArgs(example.argv, { valueFlags: example.values })
    assert.ok(parsed.command, `${example.name} command is present`)
    assert.deepEqual(parsed.positional, example.expected, `${example.name} positionals`)
    for (let i = 0; i < example.argv.length; i++) {
      const token = example.argv[i]!
      if (example.values.includes(token as never)) assert.equal(parsed.flag(token), example.argv[i + 1], `${example.name} ${token}`)
    }
  }
})
