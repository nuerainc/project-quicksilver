export interface WorkflowConditionContext {
  input: unknown
  outputs: Readonly<Record<string, unknown>>
  evaluations?: Readonly<Record<string, unknown>>
}

type Operator = '==' | '!=' | '>' | '>=' | '<' | '<=' | 'contains' | 'exists'
interface ParsedCondition { path: string; operator: Operator; value?: string | number | boolean | null }

const PATH_PATTERN = /^(?:\$input|\$steps\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+|\.\d+)*|\$nqc\.[A-Za-z0-9_-]+\.(?:reasoningScore|hallucinationRisk|brittleness|safetyDecision))$/
const EXPRESSION_PATTERN = /^\s*(\S+)\s+(>=|<=|==|!=|>|<|contains|exists)(?:\s+(.+?))?\s*$/

/** Small data-only expression language. It never evaluates JavaScript. */
export function validateWorkflowConditionExpression(expression: string): string | null {
  try {
    parseCondition(expression)
    return null
  } catch (cause) {
    return (cause as Error).message
  }
}

export function workflowConditionNodeReference(expression: string): { source: 'steps' | 'nqc'; nodeId: string } | null {
  try {
    const path = parseCondition(expression).path
    if (path === '$input') return null
    const [source, nodeId] = path.slice(1).split('.')
    return { source: source === 'steps' ? 'steps' : 'nqc', nodeId: nodeId! }
  } catch {
    return null
  }
}

export function evaluateWorkflowConditionExpression(expression: string, context: WorkflowConditionContext): boolean {
  const condition = parseCondition(expression)
  const actual = resolvePath(condition.path, context)
  if (condition.operator === 'exists') return actual !== undefined && actual !== null
  if (condition.operator === 'contains') {
    if (typeof actual === 'string') return typeof condition.value === 'string' && actual.includes(condition.value)
    if (Array.isArray(actual)) return actual.some((item) => isScalar(item) && Object.is(item, condition.value))
    throw new Error('The contains operator requires a string or an array of scalar values.')
  }
  if (condition.operator === '==') return isScalar(actual) && Object.is(actual, condition.value)
  if (condition.operator === '!=') return !isScalar(actual) || !Object.is(actual, condition.value)
  if (typeof actual !== 'number' || typeof condition.value !== 'number') {
    throw new Error('Numeric comparison operators require a numeric value on both sides.')
  }
  if (condition.operator === '>') return actual > condition.value
  if (condition.operator === '>=') return actual >= condition.value
  if (condition.operator === '<') return actual < condition.value
  return actual <= condition.value
}

function parseCondition(expression: string): ParsedCondition {
  if (typeof expression !== 'string') throw new Error('Condition must be text.')
  const match = EXPRESSION_PATTERN.exec(expression)
  if (!match) throw new Error('Use one comparison such as `$input == "approved"`, `$steps.agent-1.value exists`, or `$nqc.agent-1.reasoningScore >= 70`.')
  const path = match[1]!
  const operator = match[2] as Operator
  const rawValue = match[3]
  if (!PATH_PATTERN.test(path)) throw new Error('Condition paths must use $input, $steps.<node-id>.<field>, or a supported $nqc.<node-id> field.')
  if (operator === 'exists') {
    if (rawValue !== undefined) throw new Error('The exists operator does not take a comparison value.')
    return { path, operator }
  }
  if (rawValue === undefined) throw new Error(`The ${operator} operator needs a value.`)
  let value: unknown
  try {
    value = JSON.parse(rawValue)
  } catch {
    throw new Error('Condition values must be JSON strings, numbers, booleans, or null.')
  }
  if (!isScalar(value)) throw new Error('Condition values must be JSON strings, numbers, booleans, or null.')
  if (['>', '>=', '<', '<='].includes(operator) && typeof value !== 'number') {
    throw new Error('Numeric comparison operators require a number, for example `$nqc.agent-1.reasoningScore >= 70`.')
  }
  if (operator === 'contains' && typeof value !== 'string') throw new Error('The contains operator requires a JSON string value.')
  return { path, operator, value }
}

function resolvePath(path: string, context: WorkflowConditionContext): unknown {
  if (path === '$input') return context.input
  const parts = path.split('.')
  const root = parts[0]
  const id = parts[1]
  let value: unknown = root === '$steps' ? context.outputs[id] : context.evaluations?.[id]
  for (const part of parts.slice(2)) {
    if (Array.isArray(value) && /^\d+$/.test(part)) {
      value = value[Number(part)]
    } else if (value && typeof value === 'object' && Object.hasOwn(value, part)) {
      value = (value as Record<string, unknown>)[part]
    } else {
      return undefined
    }
  }
  return value
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean'
}
