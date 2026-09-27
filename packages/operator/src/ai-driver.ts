/**
 * The production model driver: any model the AI SDK supports (the agent
 * package's role registry picks it: Azure, OpenAI, Anthropic, Google, local).
 * Tools are passed without `execute`, so the model only proposes calls and
 * the loop (through the gate) decides and runs them.
 */
import { generateText, tool, type LanguageModel, type ModelMessage } from 'ai'

import type { LoopMessage, ModelDriver, ToolSpec } from './loop.ts'

export function toModelMessages(messages: readonly LoopMessage[]): ModelMessage[] {
  return messages.map((m): ModelMessage => {
    if (m.role === 'user') return { role: 'user', content: m.text }
    if (m.role === 'assistant') {
      return {
        role: 'assistant',
        content: [
          ...(m.text ? [{ type: 'text' as const, text: m.text }] : []),
          ...m.calls.map((c) => ({ type: 'tool-call' as const, toolCallId: c.id, toolName: c.name, input: c.input })),
        ],
      }
    }
    return { role: 'tool', content: [{ type: 'tool-result', toolCallId: m.callId, toolName: m.tool, output: { type: 'text', value: m.output } }] }
  })
}

export function aiSdkDriver(model: LanguageModel, options: { maxRetries?: number; temperature?: number } = {}): ModelDriver {
  return {
    async step({ system, messages, tools, signal }) {
      const toolset = Object.fromEntries(tools.map((t: ToolSpec) => [t.name, tool({ description: t.description, inputSchema: t.input })]))
      const r = await generateText({
        model,
        system,
        messages: toModelMessages(messages),
        tools: toolset,
        maxRetries: options.maxRetries ?? 3,
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        abortSignal: signal,
      })
      return {
        text: r.text,
        calls: r.toolCalls.map((c) => ({ id: c.toolCallId, name: c.toolName, input: c.input })),
        usage: { inputTokens: r.usage?.inputTokens ?? 0, outputTokens: r.usage?.outputTokens ?? 0 },
      }
    },
  }
}
