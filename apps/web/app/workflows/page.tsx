'use client'

import { useEffect, useRef, useState } from 'react'
import type { WorkflowEdge, WorkflowGraph, WorkflowNode, WorkflowNodeKind } from '@quicksilver/kernel'
import { authFailureMessage, consoleHeaders, readConsoleToken, type ConsoleRoute } from '@/lib/console-auth'
import { graphLayout } from '@/lib/workflow-layout'

type ValidationResponse = { valid: boolean; errors: string[]; topologicalOrder: string[] }
type PublicationVersion = { workflowId: string; version: number; graph: WorkflowGraph; digest: string; authoredBy: string; createdAt: number; status: 'draft' | 'in-review' | 'published' | 'deprecated'; reviewedBy?: string; reviewNote?: string; publishedAt?: number }
type PublicationAudit = { event: string; workflowId: string; version: number; actorId: string; at: number; digest: string; detail?: string }
type PublicationList = { versions: PublicationVersion[]; audit: PublicationAudit[] }
type WorkflowVersionDiff = { workflowId: string; fromVersion: number; toVersion: number; fromDigest: string; toDigest: string; entryNodeChanged: boolean; nodes: Array<{ id: string; change: string; changedFields: string[] }>; edges: Array<{ id: string; change: string; changedFields: string[] }>; riskChanges: Array<{ nodeId: string; field: string; from: string | boolean | null; to: string | boolean | null }> }
type WorkflowExecution = { runId: string; workflowId: string; version: number; digest: string; requestedBy: string; status: 'succeeded' | 'blocked' | 'failed'; startedAt: number; completedAt: number; durationMs: number; evaluationCount: number }
type SimulationResponse = { mode: 'simulation'; externalEffectsEnabled: false; status: 'completed' | 'blocked' | 'failed'; steps: Array<{ nodeId: string; status: 'completed' | 'skipped' | 'blocked' | 'failed'; safetyDecision?: string; detail?: string }>; error?: string }
type LiveRunResponse = { mode: 'live-read-only'; externalEffectsEnabled: false; status: 'completed' | 'blocked' | 'failed'; steps: Array<{ nodeId: string; status: 'completed' | 'skipped' | 'blocked' | 'failed'; safetyDecision?: string; detail?: string }>; error?: string; publishedWorkflow?: { workflowId: string; version: number; digest: string }; historyPersisted?: boolean; evaluations: Record<string, { reasoningScore: number; hallucinationRisk: string; brittleness: string; safetyDecision: string; issues: string[] }> }

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

/**
 * POST to a workflow route with the token signed in on the home page (this
 * tab's sessionStorage). Every workflow route requires a principal (A-3):
 * validate and simulate need workflow:read, a live run needs run:enqueue.
 */
async function postWorkflow(route: Extract<ConsoleRoute, `workflows/${string}`>, body: unknown, fallback: string): Promise<unknown> {
  const token = readConsoleToken()
  if (!token) throw new Error(`${authFailureMessage(401, route)} (use the token box on the home page).`)
  const url = `/api/${route}`
  const response = await fetch(url, {
    method: 'POST',
    headers: consoleHeaders(url, token, { 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(authFailureMessage(response.status, route, result.error, result.retryAfterSeconds) ?? result.error ?? fallback)
  return result
}

async function validateGraph(graph: unknown): Promise<ValidationResponse> {
  return (await postWorkflow('workflows/validate', { graph }, 'Could not validate the workflow.')) as ValidationResponse
}

async function getWorkflowPublications(workflowId: string): Promise<PublicationList> {
  const route: ConsoleRoute = 'workflows/publications'
  const token = readConsoleToken()
  if (!token) throw new Error(`${authFailureMessage(401, route)} (use the token box on the home page).`)
  const url = `/api/workflows/publications?workflowId=${encodeURIComponent(workflowId)}`
  const response = await fetch(url, { headers: consoleHeaders(url, token) })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(authFailureMessage(response.status, route, result.error) ?? result.error ?? 'Could not load workflow versions.')
  return result as PublicationList
}

async function getWorkflowExecutions(workflowId: string): Promise<WorkflowExecution[]> {
  const route: ConsoleRoute = 'workflows/executions'
  const token = readConsoleToken()
  if (!token) throw new Error(`${authFailureMessage(401, route)} (use the token box on the home page).`)
  const url = `/api/workflows/executions?workflowId=${encodeURIComponent(workflowId)}&limit=25`
  const response = await fetch(url, { headers: consoleHeaders(url, token) })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(authFailureMessage(response.status, route, result.error) ?? result.error ?? 'Could not load workflow execution history.')
  return (result as { executions: WorkflowExecution[] }).executions
}

async function getWorkflowVersionDiff(workflowId: string, from: number, to: number): Promise<WorkflowVersionDiff> {
  const route: ConsoleRoute = 'workflows/diff'
  const token = readConsoleToken()
  if (!token) throw new Error(`${authFailureMessage(401, route)} (use the token box on the home page).`)
  const url = `/api/workflows/diff?workflowId=${encodeURIComponent(workflowId)}&from=${from}&to=${to}`
  const response = await fetch(url, { headers: consoleHeaders(url, token) })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(authFailureMessage(response.status, route, result.error) ?? result.error ?? 'Could not compare workflow versions.')
  return result as WorkflowVersionDiff
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
  const [publication, setPublication] = useState<PublicationList>({ versions: [], audit: [] })
  const [executions, setExecutions] = useState<WorkflowExecution[]>([])
  const [executionHistoryError, setExecutionHistoryError] = useState<string | null>(null)
  const [publicationBusy, setPublicationBusy] = useState(false)
  const [publicationError, setPublicationError] = useState<string | null>(null)
  const [publicationNotice, setPublicationNotice] = useState<string | null>(null)
  const [reviewRationale, setReviewRationale] = useState('')
  const [versionDiff, setVersionDiff] = useState<WorkflowVersionDiff | null>(null)
  const [diffBusy, setDiffBusy] = useState(false)
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

  useEffect(() => {
    let cancelled = false
    setPublicationError(null)
    getWorkflowPublications(graphId).then((result) => {
      if (!cancelled) setPublication(result)
    }).catch((cause) => {
      if (!cancelled) setPublicationError((cause as Error).message || 'Could not load workflow versions.')
    })
    getWorkflowExecutions(graphId).then((result) => {
      if (!cancelled) { setExecutions(result); setExecutionHistoryError(null) }
    }).catch((cause) => {
      if (!cancelled) setExecutionHistoryError((cause as Error).message || 'Could not load workflow execution history.')
    })
    return () => { cancelled = true }
  }, [graphId])

  async function refreshPublications() {
    const result = await getWorkflowPublications(graphId)
    setPublication(result)
  }

  async function savePlatformDraft() {
    setPublicationBusy(true)
    setPublicationError(null)
    setPublicationNotice(null)
    try {
      const result = await validateGraph(graph)
      setValidation(result)
      if (!result.valid) throw new Error('Fix the workflow validation issues before saving a platform draft.')
      await postWorkflow('workflows/drafts', { graph }, 'Could not save the workflow draft.')
      await refreshPublications()
      setPublicationNotice(`Saved ${graph.id} v${graph.version} as a shared draft.`)
    } catch (cause) {
      setPublicationError((cause as Error).message || 'Could not save the workflow draft.')
    } finally {
      setPublicationBusy(false)
    }
  }

  async function submitDraft(version: number) {
    await runPublicationAction('workflows/drafts/submit', version, 'Submitted for independent review.')
  }

  async function reviewVersion(version: number) {
    if (reviewRationale.trim().length < 10) {
      setPublicationError('Add a review rationale of at least 10 characters before recording approval.')
      return
    }
    await runPublicationAction('workflows/review', version, 'Review recorded. A different publisher must release this version.', { note: reviewRationale.trim() })
    setReviewRationale('')
  }

  async function compareWithPrevious(version: number) {
    const previous = publication.versions.filter((item) => item.version < version).sort((a, b) => b.version - a.version)[0]
    if (!previous) return
    setDiffBusy(true)
    setPublicationError(null)
    try {
      setVersionDiff(await getWorkflowVersionDiff(graphId, previous.version, version))
    } catch (cause) {
      setPublicationError((cause as Error).message || 'Could not compare workflow versions.')
    } finally {
      setDiffBusy(false)
    }
  }

  async function publishVersion(version: number) {
    await runPublicationAction('workflows/publish', version, 'Workflow published. The previous active version was archived.')
  }

  async function rollbackVersion(version: number) {
    await runPublicationAction('workflows/rollback', version, 'Previously reviewed version restored as active.')
  }

  function forkVersionAsNextDraft(version: PublicationVersion) {
    const nextVersion = Math.max(version.version, ...publication.versions.map((item) => item.version)) + 1
    setGraphId(version.workflowId)
    setGraphVersion(nextVersion)
    setNodes(version.graph.nodes)
    setEdges(version.graph.edges)
    setSequence(nextSequence(version.graph.nodes, version.graph.edges))
    const trigger = version.graph.nodes.find((node) => node.kind === 'trigger')
    const first = version.graph.edges.find((edge) => edge.from === trigger?.id)
    setConnection({ from: trigger?.id ?? '', to: first?.to ?? trigger?.id ?? '', branch: '' })
    setValidation(null)
    setPublicationNotice(`Loaded immutable v${version.version} as editable v${nextVersion}. Save it as a new shared version when ready.`)
    setPublicationError(null)
  }

  async function runPublicationAction(route: Extract<ConsoleRoute, `workflows/${string}`>, version: number, success: string, extra: Record<string, unknown> = {}) {
    setPublicationBusy(true)
    setPublicationError(null)
    setPublicationNotice(null)
    try {
      await postWorkflow(route, { workflowId: graphId, version, ...extra }, success)
      await refreshPublications()
      setPublicationNotice(success)
    } catch (cause) {
      setPublicationError((cause as Error).message || 'Could not update workflow publication.')
    } finally {
      setPublicationBusy(false)
    }
  }

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
      const result = await postWorkflow('workflows/simulate', { graph }, 'Could not preview this workflow.')
      setSimulation({ graphKey: JSON.stringify(graph), result: result as SimulationResponse })
    } catch (cause) {
      setError((cause as Error).message)
    }
  }

  async function runReadOnlyWorkflow(published = false) {
    setLiveRunning(true)
    setLiveRun(null)
    setError(null)
    try {
      const active = publication.versions.find((version) => version.status === 'published')
      if (published && !active) throw new Error('Publish a workflow version before running it by version.')
      const body = published && active ? { workflowId: graphId, version: active.version, input: liveInput } : { graph, input: liveInput }
      const result = await postWorkflow('workflows/run', body, 'Could not run this workflow.') as LiveRunResponse
      setLiveRun({ graphKey: published ? `published:${graphId}:${active?.version}` : JSON.stringify(graph), result })
      if (published) setExecutions(await getWorkflowExecutions(graphId))
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
    <main className="app-main">
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-mono text-2xl tracking-[0.18em] text-quicksilver-signal">Workflow builder</h1>
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
          <details className="mb-6 rounded border border-quicksilver-border">
            <summary className="min-h-11 cursor-pointer px-3 py-3 font-mono text-[10px] uppercase tracking-widest text-quicksilver-accent">Visual flow · {nodes.length} steps, {edges.length} connections</summary>
            <div className="max-h-[440px] overflow-auto border-t border-quicksilver-border bg-quicksilver-bg" role="img" aria-label={`Workflow diagram with ${nodes.length} steps and ${edges.length} connections`}>
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
          </details>
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
          <section className="rounded border border-quicksilver-border bg-quicksilver-panel p-5">
            <h2 className="font-mono text-xs uppercase tracking-widest text-quicksilver-accent">Shared workflow lifecycle</h2>
            <p className="mt-2 text-xs leading-5 text-quicksilver-accent">Save immutable versions to the dedicated Nuera Quicksilver project. Authors submit for review; a different human reviewer and publisher are required before a version becomes active.</p><label className="mt-3 block text-xs text-quicksilver-accent">Reviewer rationale (10–500 characters)<textarea value={reviewRationale} onChange={(event) => setReviewRationale(event.target.value.slice(0, 500))} maxLength={500} rows={3} className="mt-1 w-full rounded border border-quicksilver-border bg-quicksilver-bg px-3 py-2 text-xs text-quicksilver-signal" placeholder="Record the evidence and remaining concerns behind this review." /></label>
            <button onClick={savePlatformDraft} disabled={publicationBusy || !persistenceReady} className="mt-4 w-full rounded border border-quicksilver-quicksilver bg-quicksilver-quicksilver/5 px-4 py-3 font-mono text-xs uppercase tracking-widest text-quicksilver-signal hover:bg-quicksilver-quicksilver/15 disabled:opacity-40">{publicationBusy ? 'Saving…' : `Save ${graph.id} v${graph.version} to platform`}</button>
            {publicationNotice && <p role="status" className="mt-3 text-xs text-emerald-300">{publicationNotice}</p>}
            {publicationError && <p role="alert" className="mt-3 text-xs text-red-300">{publicationError}</p>}
            <div className="mt-4 space-y-3">
              {publication.versions.map((version) => <article key={`${version.workflowId}@${version.version}`} className="rounded border border-quicksilver-border p-3">
                <div className="flex items-center justify-between gap-3"><p className="font-mono text-xs text-quicksilver-signal">v{version.version} · {version.status}</p>{version.status === 'published' && <span className="font-mono text-[9px] uppercase tracking-widest text-emerald-300">active</span>}</div>
                <p className="mt-1 break-all font-mono text-[9px] text-quicksilver-accent">{version.digest.slice(0, 24)}… · authored by {version.authoredBy}</p>
                {version.reviewedBy && <p className="mt-1 text-[10px] text-quicksilver-accent">Reviewed by {version.reviewedBy}{version.reviewNote ? ` · ${version.reviewNote}` : ''}</p>}
                <div className="mt-3 flex flex-wrap gap-2"><button disabled={diffBusy || !publication.versions.some((item) => item.version < version.version)} onClick={() => compareWithPrevious(version.version)} className="rounded border border-quicksilver-border px-2 py-1 font-mono text-[9px] uppercase text-quicksilver-signal disabled:opacity-40">{diffBusy ? 'Comparing…' : 'Compare prior version'}</button>
                  <button disabled={!persistenceReady} onClick={() => forkVersionAsNextDraft(version)} className="rounded border border-quicksilver-border px-2 py-1 font-mono text-[9px] uppercase text-quicksilver-signal disabled:opacity-40">Edit as v{Math.max(version.version, ...publication.versions.map((item) => item.version)) + 1}</button>
                  {version.status === 'draft' && <button disabled={publicationBusy} onClick={() => submitDraft(version.version)} className="rounded border border-quicksilver-border px-2 py-1 font-mono text-[9px] uppercase text-quicksilver-signal disabled:opacity-40">Submit for review</button>}
                  {version.status === 'in-review' && !version.reviewedBy && <button disabled={publicationBusy || reviewRationale.trim().length < 10} onClick={() => reviewVersion(version.version)} className="rounded border border-quicksilver-border px-2 py-1 font-mono text-[9px] uppercase text-quicksilver-signal disabled:opacity-40">Review version</button>}
                  {version.status === 'in-review' && version.reviewedBy && <button disabled={publicationBusy} onClick={() => publishVersion(version.version)} className="rounded border border-quicksilver-border px-2 py-1 font-mono text-[9px] uppercase text-quicksilver-signal disabled:opacity-40">Publish version</button>}
                  {version.status === 'deprecated' && <button disabled={publicationBusy} onClick={() => rollbackVersion(version.version)} className="rounded border border-quicksilver-border px-2 py-1 font-mono text-[9px] uppercase text-quicksilver-signal disabled:opacity-40">Restore version</button>}
                </div>
              </article>)}
              {publication.versions.length === 0 && <p className="text-xs text-quicksilver-accent">No shared versions for this workflow yet.</p>}
            </div>
            {versionDiff && <section className="mt-4 rounded border border-quicksilver-accent/40 bg-quicksilver-bg p-3"><div className="flex items-center justify-between gap-2"><h3 className="font-mono text-[10px] uppercase tracking-widest">Version diff · v{versionDiff.fromVersion} → v{versionDiff.toVersion}</h3><button onClick={() => setVersionDiff(null)} className="text-[10px] text-quicksilver-accent">Clear</button></div><p className="mt-1 break-all font-mono text-[9px] text-quicksilver-accent">{versionDiff.fromDigest.slice(0, 16)}… → {versionDiff.toDigest.slice(0, 16)}…</p>{versionDiff.entryNodeChanged && <p className="mt-2 text-xs text-amber-200">Entry node changed.</p>}<ul className="mt-2 space-y-1 text-[10px] text-quicksilver-accent">{versionDiff.nodes.map((change) => <li key={`node-${change.id}`}>Node {change.change}: {change.id}{change.changedFields.length ? ` · ${change.changedFields.join(', ')}` : ''}</li>)}{versionDiff.edges.map((change) => <li key={`edge-${change.id}`}>Edge {change.change}: {change.id}{change.changedFields.length ? ` · ${change.changedFields.join(', ')}` : ''}</li>)}</ul>{versionDiff.riskChanges.length > 0 && <div className="mt-3 rounded border border-amber-800/60 p-2"><p className="font-mono text-[9px] uppercase tracking-widest text-amber-200">Safety-relevant changes</p><ul className="mt-1 space-y-1 text-[10px] text-amber-100">{versionDiff.riskChanges.map((change) => <li key={`${change.nodeId}-${change.field}`}>{change.nodeId} · {change.field}: {String(change.from)} → {String(change.to)}</li>)}</ul></div>}{versionDiff.nodes.length === 0 && versionDiff.edges.length === 0 && !versionDiff.entryNodeChanged && versionDiff.riskChanges.length === 0 && <p className="mt-2 text-xs text-emerald-200">No workflow graph changes detected.</p>}</section>}
            {publication.audit.length > 0 && <details className="mt-4"><summary className="cursor-pointer font-mono text-[10px] uppercase tracking-widest text-quicksilver-accent">Publication history ({publication.audit.length})</summary><ol className="mt-2 space-y-2 text-[10px] text-quicksilver-accent">{publication.audit.slice(0, 12).map((event, index) => <li key={`${event.event}-${event.version}-${event.at}-${index}`}>{new Date(event.at).toLocaleString()} · {event.event} v{event.version} · {event.actorId}{event.detail ? ` · ${event.detail}` : ''}</li>)}</ol></details>}
          </section>
          <section className="rounded border border-quicksilver-border bg-quicksilver-panel p-5"><h2 className="font-mono text-xs uppercase tracking-widest text-quicksilver-accent">Safety check</h2><p className="mt-2 text-xs leading-5 text-quicksilver-accent">Validation checks graph structure, branches, step limits, evaluation, and supervisor approval requirements.</p><input ref={fileInput} type="file" accept=".json,application/json" onChange={importDraft} className="hidden" /><button onClick={() => fileInput.current?.click()} disabled={!persistenceReady} className="mb-2 w-full rounded border border-quicksilver-border px-4 py-3 font-mono text-xs uppercase tracking-widest text-quicksilver-signal hover:border-quicksilver-accent disabled:opacity-40">Import workflow JSON</button><button onClick={exportDraft} className="w-full rounded border border-quicksilver-border px-4 py-3 font-mono text-xs uppercase tracking-widest text-quicksilver-signal hover:border-quicksilver-accent">Export workflow draft</button><button onClick={validateDraft} disabled={validating} className="mt-4 w-full rounded border border-quicksilver-quicksilver bg-quicksilver-quicksilver/5 px-4 py-3 font-mono text-xs uppercase tracking-widest text-quicksilver-signal hover:bg-quicksilver-quicksilver/15 disabled:opacity-40">{validating ? 'Checking…' : 'Validate workflow'}</button>{error && <p role="alert" className="mt-3 text-xs text-red-300">{error}</p>}{validation && <div className={`mt-4 rounded border p-3 ${validation.valid ? 'border-emerald-800 bg-emerald-950/20' : 'border-amber-800 bg-amber-950/20'}`}><p className="font-mono text-xs uppercase tracking-widest">{validation.valid ? 'Ready for review' : 'Needs changes'}</p>{validation.errors.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-quicksilver-accent">{validation.errors.map((item) => <li key={item}>{item}</li>)}</ul>}{validation.valid && <p className="mt-2 text-xs text-quicksilver-accent">Topological order: {validation.topologicalOrder.join(' → ')}</p>}</div>}</section>
          <section className="rounded border border-quicksilver-border bg-quicksilver-panel p-5"><h2 className="font-mono text-xs uppercase tracking-widest text-quicksilver-accent">Run read-only workflow</h2><p className="mt-2 text-xs leading-5 text-quicksilver-accent">Calls the Nuera Quicksilver query agent and evaluates its result with the NQC Kernel. Tool steps remain blocked. This requires the server live-run flag, model credentials, and read-only Sanity Context MCP credentials.</p><label className="mt-3 block text-xs text-quicksilver-accent">Request<input value={liveInput} onChange={(event) => setLiveInput(event.target.value)} maxLength={2000} className="mt-1 w-full rounded border border-quicksilver-border bg-quicksilver-bg px-3 py-2 text-sm text-quicksilver-signal" /></label><button onClick={() => runReadOnlyWorkflow(false)} disabled={liveRunning || !persistenceReady || liveInput.trim().length < 3} className="mt-4 w-full rounded border border-quicksilver-quicksilver bg-quicksilver-quicksilver/5 px-4 py-3 font-mono text-xs uppercase tracking-widest text-quicksilver-signal hover:bg-quicksilver-quicksilver/15 disabled:opacity-40">{liveRunning ? 'Running read-only steps…' : 'Run editable draft'}</button><button onClick={() => runReadOnlyWorkflow(true)} disabled={liveRunning || !publication.versions.some((version) => version.status === 'published') || liveInput.trim().length < 3} className="mt-2 w-full rounded border border-emerald-700 px-4 py-3 font-mono text-xs uppercase tracking-widest text-emerald-200 disabled:opacity-40">Run active published version</button>{liveRun && (liveRun.graphKey === JSON.stringify(graph) || liveRun.graphKey.startsWith(`published:${graphId}:`)) && <div role="status" className="mt-4 rounded border border-quicksilver-border p-3"><p className="font-mono text-xs uppercase tracking-widest">Live read-only run · {liveRun.result.status}{liveRun.result.publishedWorkflow ? ` · published v${liveRun.result.publishedWorkflow.version}` : ` · editable draft`}</p>{liveRun.result.publishedWorkflow && <p className="mt-1 break-all text-[10px] text-quicksilver-accent">Pinned digest {liveRun.result.publishedWorkflow.digest}</p>}{liveRun.result.error && <p className="mt-2 text-xs text-amber-200">{liveRun.result.error}</p>}<ul className="mt-3 space-y-3 text-xs text-quicksilver-accent">{liveRun.result.steps.map((step) => { const evaluation = liveRun.result.evaluations[step.nodeId]; return <li key={step.nodeId}><span className="font-mono">{nodes.find((node) => node.id === step.nodeId)?.label ?? step.nodeId}</span> · {step.status}{step.safetyDecision ? ` · ${step.safetyDecision}` : ''}{step.detail ? <span className="block">{step.detail}</span> : null}{evaluation && <span className="mt-1 block">NQC score {evaluation.reasoningScore}/100 · hallucination risk {evaluation.hallucinationRisk} · brittleness {evaluation.brittleness}{evaluation.issues.length > 0 ? ` · ${evaluation.issues.join(' ')}` : ''}</span>}</li> })}</ul><p className="mt-3 text-[10px] leading-4 text-quicksilver-accent">Live model-backed query only. No workflow tool dispatch or external state changes are enabled.</p></div>}</section>          <details className="mt-4"><summary className="cursor-pointer font-mono text-[10px] uppercase tracking-widest text-quicksilver-accent">Execution history ({executions.length})</summary>{executionHistoryError ? <p className="mt-2 text-xs text-amber-200">{executionHistoryError}</p> : <ol className="mt-2 space-y-2 text-[10px] text-quicksilver-accent">{executions.map((execution) => <li key={execution.runId}>{new Date(execution.completedAt).toLocaleString()} · v{execution.version} · {execution.status} · {execution.durationMs} ms · {execution.evaluationCount} evaluations · {execution.requestedBy}</li>)}</ol>}</details><section className="rounded border border-quicksilver-border bg-quicksilver-panel p-5"><h2 className="font-mono text-xs uppercase tracking-widest text-quicksilver-accent">Run preview</h2><p className="mt-2 text-xs leading-5 text-quicksilver-accent">Simulation only: agent results are placeholders. No model, live evaluator, tool, or supervisor approval is called, and no external action can run.</p><button onClick={previewWorkflow} disabled={!persistenceReady} className="mt-4 w-full rounded border border-quicksilver-quicksilver bg-quicksilver-quicksilver/5 px-4 py-3 font-mono text-xs uppercase tracking-widest text-quicksilver-signal hover:bg-quicksilver-quicksilver/15 disabled:opacity-40">Preview workflow path</button>{simulation?.graphKey === JSON.stringify(graph) && <div role="status" className="mt-4 rounded border border-quicksilver-border p-3"><p className="font-mono text-xs uppercase tracking-widest">Simulation · {simulation.result.status}</p>{simulation.result.error && <p className="mt-2 text-xs text-amber-200">{simulation.result.error}</p>}<ul className="mt-3 space-y-2 text-xs text-quicksilver-accent">{simulation.result.steps.map((step) => <li key={step.nodeId}><span className="font-mono">{nodes.find((node) => node.id === step.nodeId)?.label ?? step.nodeId}</span> · {step.status}{step.safetyDecision ? ` · ${step.safetyDecision}` : ''}{step.detail ? <span className="block">{step.detail}</span> : null}</li>)}</ul><p className="mt-3 text-[10px] leading-4 text-quicksilver-accent">A preview is not a live evaluation or approval. Tool steps stop before dispatch.</p></div>}</section>          <section className="rounded border border-quicksilver-border bg-quicksilver-panel p-5"><h2 className="font-mono text-xs uppercase tracking-widest text-quicksilver-accent">What happens next</h2><p className="mt-2 text-xs leading-5 text-quicksilver-accent">Published versions can run through the gated read-only path and their release and run history is visible above. Hosted execution, team workspaces, scheduled deployment, and effectful tools remain in progress.</p></section>
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
