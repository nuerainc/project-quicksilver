'use client'

import { useEffect, useRef, useState } from 'react'
import type { WorkflowEdge, WorkflowGraph, WorkflowNode, WorkflowNodeKind } from '@quicksilver/kernel'

type ValidationResponse = { valid: boolean; errors: string[]; topologicalOrder: string[] }
type SimulationResponse = { mode: 'simulation'; externalEffectsEnabled: false; status: 'completed' | 'blocked' | 'failed'; steps: Array<{ nodeId: string; status: 'completed' | 'skipped' | 'blocked' | 'failed'; safetyDecision?: string; detail?: string }>; error?: string }
type LiveRunResponse = { mode: 'live-read-only'; externalEffectsEnabled: false; status: 'completed' | 'blocked' | 'failed'; steps: Array<{ nodeId: string; status: 'completed' | 'skipped' | 'blocked' | 'failed'; safetyDecision?: string; detail?: string }>; error?: string; evaluations: Record<string, { reasoningScore: number; hallucinationRisk: string; brittleness: string; safetyDecision: string; issues: string[] }> }

const initialNodes: WorkflowNode[] = [
  { id: 'trigger-1', kind: 'trigger', label: 'Start from a trigger' },
  { id: 'agent-1', kind: 'agent', label: 'Reason over the request', config: { agentId: 'query', impact: 'low', evaluationRequired: true } },
  { id: 'output-1', kind: 'output', label: 'Return the result' },
]
const initialEdges: WorkflowEdge[] = [
  { id: 'edge-1', from: 'trigger-1', to: 'agent-1' },
  { id: 'edge-2', from: 'agent-1', to: 'output-1' },
]
const nodeTitles: Record<WorkflowNodeKind, string> = { trigger: 'Trigger', agent: 'Agent', tool: 'Tool', condition: 'Condition', output: 'Output' }
const DRAFT_STORAGE_KEY = 'nuera-quicksilver/workflow-draft/v1'

async function validateGraph(graph: unknown): Promise<ValidationResponse> {
  const response = await fetch('/api/workflows/validate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ graph }),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error ?? 'Could not validate the workflow.')
  return result as ValidationResponse
}

function isWorkflowGraph(value: unknown): value is WorkflowGraph {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<WorkflowGraph>
  return candidate.schemaVersion === 1 && typeof candidate.id === 'string' && Number.isInteger(candidate.version) && typeof candidate.entryNodeId === 'string' && Array.isArray(candidate.nodes) && Array.isArray(candidate.edges)
}

function nextSequence(graphNodes: WorkflowNode[], graphEdges: WorkflowEdge[]) {
  return [...graphNodes, ...graphEdges].reduce((max, item) => {
    const match = item.id.match(/-(\d+)$/)
    return match ? Math.max(max, Number(match[1])) : max
  }, 0)
}

function graphLayout(graphNodes: WorkflowNode[], graphEdges: WorkflowEdge[]) {
  const depths = new Map<string, number>()
  const entryId = graphNodes.find((node) => node.kind === 'trigger')?.id
  if (entryId) depths.set(entryId, 0)
  for (let pass = 0; pass < graphNodes.length; pass += 1) {
    let changed = false
    for (const edge of graphEdges) {
      const sourceDepth = depths.get(edge.from)
      if (sourceDepth === undefined) continue
      const nextDepth = Math.min(sourceDepth + 1, graphNodes.length - 1)
      if ((depths.get(edge.to) ?? -1) < nextDepth) {
        depths.set(edge.to, nextDepth)
        changed = true
      }
    }
    if (!changed) break
  }
  for (const node of graphNodes) if (!depths.has(node.id)) depths.set(node.id, 0)

  const layers = new Map<number, WorkflowNode[]>()
  for (const node of graphNodes) {
    const depth = depths.get(node.id) ?? 0
    layers.set(depth, [...(layers.get(depth) ?? []), node])
  }
  const positions = new Map<string, { x: number; y: number }>()
  let maxRows = 1
  for (const [depth, layer] of layers) {
    maxRows = Math.max(maxRows, layer.length)
    layer.forEach((node, row) => positions.set(node.id, { x: 32 + depth * 230, y: 24 + row * 88 }))
  }
  const maxDepth = Math.max(0, ...layers.keys())
  return { positions, width: 64 + (maxDepth + 1) * 230, height: 48 + maxRows * 88 }
}

export default function WorkflowBuilderPage() {
  const [nodes, setNodes] = useState<WorkflowNode[]>(initialNodes)
  const [edges, setEdges] = useState<WorkflowEdge[]>(initialEdges)
  const [sequence, setSequence] = useState(2)
  const [validation, setValidation] = useState<ValidationResponse | null>(null)
  const [validating, setValidating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [connection, setConnection] = useState({ from: 'trigger-1', to: 'agent-1', branch: '' })
  const [graphId, setGraphId] = useState('workflow-draft')
  const [graphVersion, setGraphVersion] = useState(1)
  const [persistenceReady, setPersistenceReady] = useState(false)
  const [storageAvailable, setStorageAvailable] = useState(true)
  const fileInput = useRef<HTMLInputElement>(null)
  const [simulation, setSimulation] = useState<{ graphKey: string; result: SimulationResponse } | null>(null)
  const [liveInput, setLiveInput] = useState('Summarize the available information relevant to this request.')
  const [liveRunning, setLiveRunning] = useState(false)
  const [liveRun, setLiveRun] = useState<{ graphKey: string; result: LiveRunResponse } | null>(null)

  const graph: WorkflowGraph = {
    schemaVersion: 1,
    id: graphId,
    version: graphVersion,
    entryNodeId: nodes.find((node) => node.kind === 'trigger')?.id ?? '',
    nodes,
    edges,
  }
  const map = graphLayout(nodes, edges)

  useEffect(() => {
    let cancelled = false
    async function restoreDraft() {
      let saved: string | null
      try {
        saved = window.localStorage.getItem(DRAFT_STORAGE_KEY)
      } catch {
        if (!cancelled) {
          setStorageAvailable(false)
          setError('Browser storage is unavailable. Your draft will not be saved on this device.')
          setPersistenceReady(true)
        }
        return
      }
      if (!saved) {
        if (!cancelled) setPersistenceReady(true)
        return
      }
      try {
        const parsed: unknown = JSON.parse(saved)
        const payload = parsed && typeof parsed === 'object' && 'graph' in parsed ? (parsed as { graph: unknown }).graph : parsed
        if (!isWorkflowGraph(payload)) throw new Error('The saved browser draft is not a supported workflow file. It has been kept intact.')
        const result = await validateGraph(payload)
        if (!result.valid) {
          if (!cancelled) {
            setValidation(result)
            setStorageAvailable(false)
            setError('The saved draft needs changes before it can be restored. The saved copy has been kept intact.')
            setPersistenceReady(true)
          }
          return
        }
        if (cancelled) return
        setGraphId(payload.id)
        setGraphVersion(payload.version)
        setNodes(payload.nodes)
        setEdges(payload.edges)
        setSequence(nextSequence(payload.nodes, payload.edges))
        const trigger = payload.nodes.find((node) => node.kind === 'trigger')
        const first = payload.edges.find((edge) => edge.from === trigger?.id)
        setConnection({ from: trigger?.id ?? '', to: first?.to ?? trigger?.id ?? '', branch: '' })
        setValidation(result)
        setPersistenceReady(true)
      } catch (cause) {
        if (!cancelled) {
          setStorageAvailable(false)
          setError(`${(cause as Error).message} The existing browser copy was not changed.`)
          setPersistenceReady(true)
        }
      }
    }
    void restoreDraft()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!persistenceReady || !storageAvailable) return
    const timeout = window.setTimeout(() => {
      try {
        window.localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({ formatVersion: 1, graph, savedAt: new Date().toISOString() }))
      } catch {
        setStorageAvailable(false)
        setError('Browser storage is full or unavailable. Export your draft to keep a portable copy.')
      }
    }, 250)
    return () => window.clearTimeout(timeout)
  }, [nodes, edges, graphId, graphVersion, persistenceReady, storageAvailable])

  function addNode(kind: WorkflowNodeKind) {
    const id = `${kind}-${sequence + 1}`
    const node: WorkflowNode = {
      id,
      kind,
      label: `${nodeTitles[kind]} ${sequence + 1}`,
      ...(kind === 'agent' ? { config: { agentId: 'query', impact: 'low' as const, evaluationRequired: true } } : {}),
      ...(kind === 'tool' ? { config: { toolId: '', impact: 'low' as const } } : {}),
    }
    setNodes((current) => [...current, node])
    setSequence((current) => current + 1)
    setValidation(null)
    setConnection((current) => ({ ...current, to: id }))
  }

  function updateNode(id: string, patch: Partial<WorkflowNode>) {
    setNodes((current) => current.map((node) => node.id === id ? { ...node, ...patch } : node))
    setValidation(null)
  }

  function updateConfig(id: string, patch: NonNullable<WorkflowNode['config']>) {
    setNodes((current) => current.map((node) => node.id === id ? { ...node, config: { ...node.config, ...patch } } : node))
    setValidation(null)
  }

  function addConnection() {
    const id = `edge-${sequence + edges.length + 1}`
    setEdges((current) => [...current, { id, from: connection.from, to: connection.to, ...(connection.branch ? { branch: connection.branch } : {}) }])
    setValidation(null)
  }

  function removeNode(id: string) {
    if (nodes.find((node) => node.id === id)?.kind === 'trigger') return
    setNodes((current) => current.filter((node) => node.id !== id))
    setEdges((current) => current.filter((edge) => edge.from !== id && edge.to !== id))
    setConnection((current) => ({ from: current.from === id ? 'trigger-1' : current.from, to: current.to === id ? 'trigger-1' : current.to, branch: current.branch }))
    setValidation(null)
  }

  function removeConnection(id: string) {
    setEdges((current) => current.filter((edge) => edge.id !== id))
    setValidation(null)
  }

  function exportDraft() {
    const content = new Blob([JSON.stringify(graph, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(content)
    const link = document.createElement('a')
    link.href = url
    link.download = `${graph.id}-v${graph.version}.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  async function validateDraft() {
    setValidating(true)
    setError(null)
    setValidation(null)
    try {
      const result = await validateGraph(graph)
      setValidation(result)
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setValidating(false)
    }
  }

  async function previewWorkflow() {
    setSimulation(null)
    setError(null)
    try {
      const response = await fetch('/api/workflows/simulate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ graph }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? 'Could not preview this workflow.')
      setSimulation({ graphKey: JSON.stringify(graph), result: result as SimulationResponse })
    } catch (cause) {
      setError((cause as Error).message)
    }
  }

  async function runReadOnlyWorkflow() {
    setLiveRunning(true)
    setLiveRun(null)
    setError(null)
    try {
      const response = await fetch('/api/workflows/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          graph,
          input: liveInput,
        }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? 'Could not run this workflow.')
      setLiveRun({ graphKey: JSON.stringify(graph), result: result as LiveRunResponse })
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setLiveRunning(false)
    }
  }

  async function importDraft(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setError(null)
    setValidation(null)
    try {
      const parsed: unknown = JSON.parse(await file.text())
      const candidate = parsed && typeof parsed === 'object' && 'graph' in parsed ? (parsed as { graph: unknown }).graph : parsed
      if (!isWorkflowGraph(candidate)) throw new Error('Choose a Quicksilver workflow JSON file with a supported graph format.')
      const result = await validateGraph(candidate)
      setValidation(result)
      if (!result.valid) {
        setError('This workflow has validation issues. Your current draft was left unchanged.')
        return
      }
      setGraphId(candidate.id)
      setGraphVersion(candidate.version)
      setNodes(candidate.nodes)
      setEdges(candidate.edges)
      setSequence(nextSequence(candidate.nodes, candidate.edges))
      setStorageAvailable(true)
      setPersistenceReady(true)
      const trigger = candidate.nodes.find((node) => node.kind === 'trigger')
      const first = candidate.edges.find((edge) => edge.from === trigger?.id)
      setConnection({ from: trigger?.id ?? '', to: first?.to ?? trigger?.id ?? '', branch: '' })
    } catch (cause) {
      setError((cause as Error).message || 'Could not read that workflow file.')
    }
  }

  return (
    <main className="mx-auto max-w-7xl px-6 py-10">
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <a href="/" className="font-mono text-xs uppercase tracking-widest text-quicksilver-accent hover:text-quicksilver-signal">← Nuera Quicksilver</a>
          <h1 className="mt-3 font-mono text-2xl tracking-[0.18em] text-quicksilver-signal">Workflow builder</h1>
          <p className="mt-2 max-w-2xl text-sm text-quicksilver-accent">Arrange agent, tool, and decision steps, then check the workflow against NQC safety rules.</p>
        </div>
        <span className="rounded border border-quicksilver-border px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-quicksilver-accent">{!persistenceReady ? 'Restoring browser draft…' : storageAvailable ? 'Autosaved in this browser · not executable' : 'Browser saving unavailable'}</span>
      </header>

      <section className="mb-6 rounded border border-quicksilver-border bg-quicksilver-panel p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><h2 className="font-mono text-xs uppercase tracking-widest text-quicksilver-accent">Add a step</h2><p className="mt-1 text-xs text-quicksilver-accent">Start with the trigger and finish with an output.</p></div>
          <div className="flex flex-wrap gap-2">
            {(['agent', 'tool', 'condition', 'output'] as WorkflowNodeKind[]).map((kind) => <button key={kind} onClick={() => addNode(kind)} className="rounded border border-quicksilver-border px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-quicksilver-signal hover:border-quicksilver-accent">+ {nodeTitles[kind]}</button>)}
          </div>
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
        <section aria-label="Workflow graph" className="rounded border border-quicksilver-border bg-quicksilver-panel p-5">
          <div className="mb-5 flex items-center justify-between"><h2 className="font-mono text-xs uppercase tracking-widest text-quicksilver-accent">Workflow graph</h2><span className="font-mono text-[10px] text-quicksilver-accent">{nodes.length} steps · {edges.length} connections</span></div>
          <h3 className="mb-3 font-mono text-[10px] uppercase tracking-widest text-quicksilver-accent">Visual flow · connections and branches</h3>
          <div className="mb-6 max-h-[440px] overflow-auto rounded border border-quicksilver-border bg-quicksilver-bg" role="img" aria-label={`Workflow diagram with ${nodes.length} steps and ${edges.length} connections`}>
            <svg width={map.width} height={map.height} viewBox={`0 0 ${map.width} ${map.height}`} className="min-w-full">
              <defs><marker id="workflow-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#56d7e7" /></marker></defs>
              {edges.map((edge) => {
                const from = map.positions.get(edge.from)
                const to = map.positions.get(edge.to)
                if (!from || !to) return null
                const startX = from.x + 180
                const startY = from.y + 29
                const endX = to.x
                const endY = to.y + 29
                const middleX = (startX + endX) / 2
                const middleY = (startY + endY) / 2
                return <g key={edge.id}><path d={`M ${startX} ${startY} C ${middleX} ${startY}, ${middleX} ${endY}, ${endX - 7} ${endY}`} fill="none" stroke="#56d7e7" strokeOpacity="0.65" strokeWidth="1.5" markerEnd="url(#workflow-arrow)" />{edge.branch && <text x={middleX} y={middleY - 5} textAnchor="middle" fill="#a8b7c7" fontSize="10">{edge.branch}</text>}</g>
              })}
              {nodes.map((node) => {
                const point = map.positions.get(node.id)
                if (!point) return null
                const stroke = node.kind === 'condition' ? '#f0be65' : node.kind === 'agent' ? '#56d7e7' : '#60778d'
                return <g key={node.id}><rect x={point.x} y={point.y} width="180" height="58" rx="5" fill="#0b1119" stroke={stroke} strokeWidth="1.5" /><text x={point.x + 10} y={point.y + 19} fill={stroke} fontSize="9" letterSpacing="1">{node.kind.toUpperCase()}</text><text x={point.x + 10} y={point.y + 39} fill="#edf4fa" fontSize="12">{node.label.length > 22 ? `${node.label.slice(0, 21)}…` : node.label}</text></g>
              })}
            </svg>
          </div>
          <h3 className="mb-3 font-mono text-[10px] uppercase tracking-widest text-quicksilver-accent">Step settings</h3>
          <div className="space-y-3">
            {nodes.map((node, index) => (
              <div key={node.id} className="relative rounded border border-quicksilver-border bg-quicksilver-bg p-4">
                {index > 0 && <div aria-hidden="true" className="absolute -top-4 left-8 h-4 border-l border-quicksilver-accent/50" />}
                <div className="mb-3 flex items-center gap-3"><span className="flex h-7 w-7 items-center justify-center rounded-full border border-quicksilver-accent/50 font-mono text-[10px] text-quicksilver-signal">{index + 1}</span><span className="font-mono text-[10px] uppercase tracking-widest text-quicksilver-accent">{nodeTitles[node.kind]}</span><span className="ml-auto font-mono text-[10px] text-quicksilver-accent">{node.id}</span>{node.kind !== 'trigger' && <button onClick={() => removeNode(node.id)} aria-label={`Remove ${node.label}`} className="font-mono text-[10px] text-quicksilver-accent hover:text-red-300">Remove</button>}</div>
                <label className="block text-xs text-quicksilver-accent">Step name<input value={node.label} onChange={(event) => updateNode(node.id, { label: event.target.value })} className="mt-1 w-full rounded border border-quicksilver-border bg-quicksilver-panel px-3 py-2 text-sm text-quicksilver-signal focus:border-quicksilver-accent focus:outline-none" /></label>
                {node.kind === 'condition' && <label className="mt-3 block text-xs text-quicksilver-accent">Condition<input value={node.config?.conditionExpression ?? ''} onChange={(event) => updateConfig(node.id, { conditionExpression: event.target.value })} placeholder={'$nqc.agent-1.reasoningScore >= 70'} className="mt-1 w-full rounded border border-quicksilver-border bg-quicksilver-panel px-3 py-2 text-sm text-quicksilver-signal" /><span className="mt-1 block text-[10px]">Use $input, $steps.&lt;node-id&gt;.&lt;field&gt;, or $nqc.&lt;agent-node-id&gt;.reasoningScore with comparisons or exists.</span></label>}
                {node.kind === 'agent' && <div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="text-xs text-quicksilver-accent">Agent configuration key<input value={node.config?.agentId ?? ''} onChange={(event) => updateConfig(node.id, { agentId: event.target.value })} className="mt-1 w-full rounded border border-quicksilver-border bg-quicksilver-panel px-3 py-2 text-sm text-quicksilver-signal" /></label><ImpactField value={node.config?.impact ?? 'low'} onChange={(impact) => updateConfig(node.id, { impact })} /><ExecutionPolicyFields config={node.config ?? {}} onChange={(patch) => updateConfig(node.id, patch)} allowRetries />{(node.config?.impact === 'high' || node.config?.impact === 'critical') && <SafetyGates config={node.config} onChange={(patch) => updateConfig(node.id, patch)} />}</div>}
                {node.kind === 'tool' && <div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="text-xs text-quicksilver-accent">Tool contract key<input value={node.config?.toolId ?? ''} onChange={(event) => updateConfig(node.id, { toolId: event.target.value })} className="mt-1 w-full rounded border border-quicksilver-border bg-quicksilver-panel px-3 py-2 text-sm text-quicksilver-signal" /></label><ImpactField value={node.config?.impact ?? 'low'} onChange={(impact) => updateConfig(node.id, { impact })} /><ExecutionPolicyFields config={node.config ?? {}} onChange={(patch) => updateConfig(node.id, patch)} /> <label className="flex items-center gap-2 text-xs text-quicksilver-accent"><input type="checkbox" checked={node.config?.sideEffect ?? false} onChange={(event) => updateConfig(node.id, { sideEffect: event.target.checked, evaluationRequired: event.target.checked || node.config?.evaluationRequired, supervisorApprovalRequired: event.target.checked || node.config?.supervisorApprovalRequired })} /> Tool changes external state</label>{(node.config?.sideEffect || node.config?.impact === 'high' || node.config?.impact === 'critical') && <SafetyGates config={node.config} onChange={(patch) => updateConfig(node.id, patch)} />}</div>}
              </div>
            ))}
          </div>

          <div className="mt-6 border-t border-quicksilver-border pt-5">
            <h3 className="mb-3 font-mono text-[10px] uppercase tracking-widest text-quicksilver-accent">Connections</h3>
            <div className="grid gap-3 sm:grid-cols-[1fr_1fr_0.7fr_auto]">
              <select aria-label="Connection source" value={connection.from} onChange={(event) => setConnection({ ...connection, from: event.target.value })} className="rounded border border-quicksilver-border bg-quicksilver-bg px-3 py-2 text-xs text-quicksilver-signal">{nodes.map((node) => <option key={node.id} value={node.id}>{node.label || node.id}</option>)}</select>
              <select aria-label="Connection destination" value={connection.to} onChange={(event) => setConnection({ ...connection, to: event.target.value })} className="rounded border border-quicksilver-border bg-quicksilver-bg px-3 py-2 text-xs text-quicksilver-signal">{nodes.map((node) => <option key={node.id} value={node.id}>{node.label || node.id}</option>)}</select>
              <select aria-label="Condition branch" value={connection.branch} onChange={(event) => setConnection({ ...connection, branch: event.target.value })} className="rounded border border-quicksilver-border bg-quicksilver-bg px-3 py-2 text-xs text-quicksilver-signal"><option value="">Unbranched</option><option value="true">True</option><option value="false">False</option></select>
              <button onClick={addConnection} className="rounded border border-quicksilver-border px-3 py-2 font-mono text-[10px] uppercase tracking-widest hover:border-quicksilver-accent">Connect</button>
            </div>
            <ul className="mt-3 space-y-2">{edges.map((edge) => <li key={edge.id} className="flex items-center gap-2 text-xs text-quicksilver-accent"><span>{nodes.find((node) => node.id === edge.from)?.label ?? edge.from} → {nodes.find((node) => node.id === edge.to)?.label ?? edge.to}{edge.branch ? ` · ${edge.branch}` : ''}</span><button onClick={() => removeConnection(edge.id)} aria-label={`Remove connection ${edge.id}`} className="ml-auto text-quicksilver-accent hover:text-red-300">Remove</button></li>)}</ul>
          </div>
        </section>

        <aside className="space-y-4">
          <section className="rounded border border-quicksilver-border bg-quicksilver-panel p-5"><h2 className="font-mono text-xs uppercase tracking-widest text-quicksilver-accent">Safety check</h2><p className="mt-2 text-xs leading-5 text-quicksilver-accent">Validation checks graph structure, branches, step limits, evaluation, and supervisor approval requirements.</p><input ref={fileInput} type="file" accept=".json,application/json" onChange={importDraft} className="hidden" /><button onClick={() => fileInput.current?.click()} disabled={!persistenceReady} className="mb-2 w-full rounded border border-quicksilver-border px-4 py-3 font-mono text-xs uppercase tracking-widest text-quicksilver-signal hover:border-quicksilver-accent disabled:opacity-40">Import workflow JSON</button><button onClick={exportDraft} className="w-full rounded border border-quicksilver-border px-4 py-3 font-mono text-xs uppercase tracking-widest text-quicksilver-signal hover:border-quicksilver-accent">Export workflow draft</button><button onClick={validateDraft} disabled={validating} className="mt-4 w-full rounded border border-quicksilver-quicksilver bg-quicksilver-quicksilver/5 px-4 py-3 font-mono text-xs uppercase tracking-widest text-quicksilver-signal hover:bg-quicksilver-quicksilver/15 disabled:opacity-40">{validating ? 'Checking…' : 'Validate workflow'}</button>{error && <p role="alert" className="mt-3 text-xs text-red-300">{error}</p>}{validation && <div className={`mt-4 rounded border p-3 ${validation.valid ? 'border-emerald-800 bg-emerald-950/20' : 'border-amber-800 bg-amber-950/20'}`}><p className="font-mono text-xs uppercase tracking-widest">{validation.valid ? 'Ready for review' : 'Needs changes'}</p>{validation.errors.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-quicksilver-accent">{validation.errors.map((item) => <li key={item}>{item}</li>)}</ul>}{validation.valid && <p className="mt-2 text-xs text-quicksilver-accent">Topological order: {validation.topologicalOrder.join(' → ')}</p>}</div>}</section>
          <section className="rounded border border-quicksilver-border bg-quicksilver-panel p-5"><h2 className="font-mono text-xs uppercase tracking-widest text-quicksilver-accent">Run read-only workflow</h2><p className="mt-2 text-xs leading-5 text-quicksilver-accent">Calls the Nuera Quicksilver query agent and evaluates its result with the NQC Kernel. Tool steps remain blocked. This requires the server live-run flag, model credentials, and read-only Sanity Context MCP credentials.</p><label className="mt-3 block text-xs text-quicksilver-accent">Request<input value={liveInput} onChange={(event) => setLiveInput(event.target.value)} maxLength={2000} className="mt-1 w-full rounded border border-quicksilver-border bg-quicksilver-bg px-3 py-2 text-sm text-quicksilver-signal" /></label><button onClick={runReadOnlyWorkflow} disabled={liveRunning || !persistenceReady || liveInput.trim().length < 3} className="mt-4 w-full rounded border border-quicksilver-quicksilver bg-quicksilver-quicksilver/5 px-4 py-3 font-mono text-xs uppercase tracking-widest text-quicksilver-signal hover:bg-quicksilver-quicksilver/15 disabled:opacity-40">{liveRunning ? 'Running read-only steps…' : 'Run workflow'}</button>{liveRun?.graphKey === JSON.stringify(graph) && <div role="status" className="mt-4 rounded border border-quicksilver-border p-3"><p className="font-mono text-xs uppercase tracking-widest">Live read-only run · {liveRun.result.status}</p>{liveRun.result.error && <p className="mt-2 text-xs text-amber-200">{liveRun.result.error}</p>}<ul className="mt-3 space-y-3 text-xs text-quicksilver-accent">{liveRun.result.steps.map((step) => { const evaluation = liveRun.result.evaluations[step.nodeId]; return <li key={step.nodeId}><span className="font-mono">{nodes.find((node) => node.id === step.nodeId)?.label ?? step.nodeId}</span> · {step.status}{step.safetyDecision ? ` · ${step.safetyDecision}` : ''}{step.detail ? <span className="block">{step.detail}</span> : null}{evaluation && <span className="mt-1 block">NQC score {evaluation.reasoningScore}/100 · hallucination risk {evaluation.hallucinationRisk} · brittleness {evaluation.brittleness}{evaluation.issues.length > 0 ? ` · ${evaluation.issues.join(' ')}` : ''}</span>}</li> })}</ul><p className="mt-3 text-[10px] leading-4 text-quicksilver-accent">Live model-backed query only. No workflow tool dispatch or external state changes are enabled.</p></div>}</section>          <section className="rounded border border-quicksilver-border bg-quicksilver-panel p-5"><h2 className="font-mono text-xs uppercase tracking-widest text-quicksilver-accent">Run preview</h2><p className="mt-2 text-xs leading-5 text-quicksilver-accent">Simulation only: agent results are placeholders. No model, live evaluator, tool, or supervisor approval is called, and no external action can run.</p><button onClick={previewWorkflow} disabled={!persistenceReady} className="mt-4 w-full rounded border border-quicksilver-quicksilver bg-quicksilver-quicksilver/5 px-4 py-3 font-mono text-xs uppercase tracking-widest text-quicksilver-signal hover:bg-quicksilver-quicksilver/15 disabled:opacity-40">Preview workflow path</button>{simulation?.graphKey === JSON.stringify(graph) && <div role="status" className="mt-4 rounded border border-quicksilver-border p-3"><p className="font-mono text-xs uppercase tracking-widest">Simulation · {simulation.result.status}</p>{simulation.result.error && <p className="mt-2 text-xs text-amber-200">{simulation.result.error}</p>}<ul className="mt-3 space-y-2 text-xs text-quicksilver-accent">{simulation.result.steps.map((step) => <li key={step.nodeId}><span className="font-mono">{nodes.find((node) => node.id === step.nodeId)?.label ?? step.nodeId}</span> · {step.status}{step.safetyDecision ? ` · ${step.safetyDecision}` : ''}{step.detail ? <span className="block">{step.detail}</span> : null}</li>)}</ul><p className="mt-3 text-[10px] leading-4 text-quicksilver-accent">A preview is not a live evaluation or approval. Tool steps stop before dispatch.</p></div>}</section>          <section className="rounded border border-quicksilver-border bg-quicksilver-panel p-5"><h2 className="font-mono text-xs uppercase tracking-widest text-quicksilver-accent">What happens next</h2><p className="mt-2 text-xs leading-5 text-quicksilver-accent">This draft autosaves in this browser and can be imported or exported as JSON. Shared storage, publishing, team permissions, and execution still need the dedicated project and runtime security controls.</p></section>
        </aside>
      </div>
    </main>
  )
}

function ImpactField({ value, onChange }: { value: NonNullable<WorkflowNode['config']>['impact']; onChange: (value: NonNullable<WorkflowNode['config']>['impact']) => void }) {
  return <label className="text-xs text-quicksilver-accent">Impact level<select value={value ?? 'low'} onChange={(event) => onChange(event.target.value as NonNullable<WorkflowNode['config']>['impact'])} className="mt-1 w-full rounded border border-quicksilver-border bg-quicksilver-panel px-3 py-2 text-sm text-quicksilver-signal"><option value="low">Low</option><option value="moderate">Moderate</option><option value="high">High</option><option value="critical">Critical</option></select></label>
}

function SafetyGates({ config, onChange }: { config: NonNullable<WorkflowNode['config']>; onChange: (patch: NonNullable<WorkflowNode['config']>) => void }) {
  return <div className="flex flex-wrap gap-x-4 gap-y-2 sm:col-span-2"><label className="flex items-center gap-2 text-xs text-quicksilver-accent"><input type="checkbox" checked={config.evaluationRequired ?? false} onChange={(event) => onChange({ evaluationRequired: event.target.checked })} /> Require Quicksilver Engine evaluation</label><label className="flex items-center gap-2 text-xs text-quicksilver-accent"><input type="checkbox" checked={config.supervisorApprovalRequired ?? false} onChange={(event) => onChange({ supervisorApprovalRequired: event.target.checked })} /> Require supervisor approval</label></div>
}

function ExecutionPolicyFields({ config, onChange, allowRetries = false }: { config: NonNullable<WorkflowNode['config']>; onChange: (patch: NonNullable<WorkflowNode['config']>) => void; allowRetries?: boolean }) {
  return <>
    {allowRetries && <label className="text-xs text-quicksilver-accent">Agent attempts (including first)<input type="number" min={1} max={10} step={1} value={config.maxAttempts ?? 1} onChange={(event) => onChange({ maxAttempts: event.target.value ? Number(event.target.value) : undefined })} className="mt-1 w-full rounded border border-quicksilver-border bg-quicksilver-panel px-3 py-2 text-sm text-quicksilver-signal" /><span className="mt-1 block text-[10px]">Retries only apply to agent-handler failures. Tools are never retried automatically.</span></label>}
    <label className="text-xs text-quicksilver-accent">Handler timeout (ms)<input type="number" min={1} max={300000} step={1000} placeholder="No timeout" value={config.timeoutMs ?? ''} onChange={(event) => onChange({ timeoutMs: event.target.value ? Number(event.target.value) : undefined })} className="mt-1 w-full rounded border border-quicksilver-border bg-quicksilver-panel px-3 py-2 text-sm text-quicksilver-signal" /><span className="mt-1 block text-[10px]">Handlers receive an abort signal; they must honor it to stop provider work.</span></label>
  </>
}
