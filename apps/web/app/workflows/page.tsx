'use client'

import { useEffect, useRef, useState } from 'react'
import type { WorkflowEdge, WorkflowGraph, WorkflowNode, WorkflowNodeKind } from '@quicksilver/kernel'
import { validateWorkflowGraph } from '@quicksilver/kernel/workflows/graph'
import { authFailureMessage, consoleHeaders, resolveConsoleAccess, type ConsoleRoute } from '@/lib/console-auth'
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
const nodeTitles: Record<WorkflowNodeKind, string> = { trigger: 'Trigger', agent: 'Agent', tool: 'Tool', condition: 'Condition', loop: 'Bounded loop', output: 'Output' }
const DRAFT_STORAGE_KEY = 'nuera-quicksilver/workflow-draft/v1'

/**
 * POST to a workflow route as the signed-in person (a pasted token in this
 * tab's sessionStorage, or the OIDC browser session). Every workflow route requires a principal (A-3):
 * validate and simulate need workflow:read, a live run needs run:enqueue.
 */
async function postWorkflow(route: Extract<ConsoleRoute, `workflows/${string}`>, body: unknown, fallback: string): Promise<unknown> {
  const access = await resolveConsoleAccess()
  if (!access.signedIn) throw new Error(`${authFailureMessage(401, route)} (sign in first).`)
  const url = `/api/${route}`
  const response = await fetch(url, {
    method: 'POST',
    headers: consoleHeaders(url, access.token, { 'content-type': 'application/json' }),
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
  const access = await resolveConsoleAccess()
  if (!access.signedIn) throw new Error(`${authFailureMessage(401, route)} (sign in first).`)
  const url = `/api/workflows/publications?workflowId=${encodeURIComponent(workflowId)}`
  const response = await fetch(url, { headers: consoleHeaders(url, access.token) })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(authFailureMessage(response.status, route, result.error) ?? result.error ?? 'Could not load workflow versions.')
  return result as PublicationList
}

async function getWorkflowExecutions(workflowId: string): Promise<WorkflowExecution[]> {
  const route: ConsoleRoute = 'workflows/executions'
  const access = await resolveConsoleAccess()
  if (!access.signedIn) throw new Error(`${authFailureMessage(401, route)} (sign in first).`)
  const url = `/api/workflows/executions?workflowId=${encodeURIComponent(workflowId)}&limit=25`
  const response = await fetch(url, { headers: consoleHeaders(url, access.token) })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(authFailureMessage(response.status, route, result.error) ?? result.error ?? 'Could not load workflow execution history.')
  return (result as { executions: WorkflowExecution[] }).executions
}

async function getWorkflowVersionDiff(workflowId: string, from: number, to: number): Promise<WorkflowVersionDiff> {
  const route: ConsoleRoute = 'workflows/diff'
  const access = await resolveConsoleAccess()
  if (!access.signedIn) throw new Error(`${authFailureMessage(401, route)} (sign in first).`)
  const url = `/api/workflows/diff?workflowId=${encodeURIComponent(workflowId)}&from=${from}&to=${to}`
  const response = await fetch(url, { headers: consoleHeaders(url, access.token) })
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

function LoopBodyEditor({ body, onApply }: { body: WorkflowGraph; onApply: (body: WorkflowGraph) => void }) {
  const [draft, setDraft] = useState(() => JSON.stringify(body, null, 2))
  const [error, setError] = useState<string | null>(null)
  function apply() {
    try {
      const candidate: unknown = JSON.parse(draft)
      if (!isWorkflowGraph(candidate)) throw new Error('Provide a workflow graph with schemaVersion, id, version, entryNodeId, nodes, and edges.')
      const result = validateWorkflowGraph(candidate)
      if (!result.valid) throw new Error(result.errors.join(' '))
      if (candidate.nodes.some((node) => node.kind === 'loop')) throw new Error('Loop bodies cannot contain another loop.')
      if (candidate.nodes.length > 50) throw new Error('Loop bodies are limited to 50 steps.')
      onApply(candidate)
      setError(null)
    } catch (cause) {
      setError((cause as Error).message || 'Could not apply this loop body.')
    }
  }
  return <div className="mt-3 rounded-lg border border-quicksilver-border p-3">
    <label className="block text-xs font-medium text-quicksilver-signal">Loop body graph (JSON)<textarea aria-label="Loop body graph JSON" value={draft} onChange={(event) => setDraft(event.target.value)} spellCheck={false} rows={12} className="qs-field mt-2 font-mono text-xs" /></label>
    <div className="mt-2 flex flex-wrap items-center gap-3"><button type="button" onClick={apply} className="qs-action-secondary min-h-9 px-3 py-1 text-xs">Apply loop body</button><span className="text-[11px] text-quicksilver-accent">Validated DAG · max 50 steps · no nested loops</span></div>
    {error && <p role="alert" className="mt-2 text-xs text-red-300">{error}</p>}
  </div>
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
  const diagramViewport = useRef<HTMLDivElement>(null)
  const [diagramSize, setDiagramSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const viewport = diagramViewport.current
    if (!viewport) return
    const measure = () => {
      // clientWidth/clientHeight include the viewport padding. Measure the
      // actual SVG content box so the rendered map never gets clipped at a
      // breakpoint or when the browser is resized.
      const styles = window.getComputedStyle(viewport)
      const horizontalPadding = Number.parseFloat(styles.paddingLeft) + Number.parseFloat(styles.paddingRight)
      const verticalPadding = Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom)
      setDiagramSize({
        width: Math.max(0, viewport.clientWidth - horizontalPadding),
        height: Math.max(0, viewport.clientHeight - verticalPadding),
      })
    }
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [])

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
    const loopBody: WorkflowGraph = {
      schemaVersion: 1,
      id: `workflow-draft-${id}-body`,
      version: 1,
      entryNodeId: `${id}-start`,
      nodes: [
        { id: `${id}-start`, kind: 'trigger', label: 'Iteration input' },
        { id: `${id}-agent`, kind: 'agent', label: 'Work this iteration', config: { agentId: 'query', impact: 'low', evaluationRequired: true } },
        { id: `${id}-output`, kind: 'output', label: 'Iteration result' },
      ],
      edges: [{ id: `${id}-in`, from: `${id}-start`, to: `${id}-agent` }, { id: `${id}-out`, from: `${id}-agent`, to: `${id}-output` }],
    }
    const node: WorkflowNode = {
      id,
      kind,
      label: `${nodeTitles[kind]} ${sequence + 1}`,
      ...(kind === 'agent' ? { config: { agentId: 'query', impact: 'low' as const, evaluationRequired: true } } : {}),
      ...(kind === 'tool' ? { config: { toolId: '', impact: 'low' as const } } : {}),
      ...(kind === 'loop' ? { config: { loop: { maxIterations: 5, maxDurationMs: 60_000, continueWhile: '$input.iteration < 2', body: loopBody } } } : {}),
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
      <header className="mb-8 flex flex-wrap items-end justify-between gap-5">
        <div>
          <p className="qs-eyebrow mb-2">Workflow studio <span aria-hidden="true">/</span> Draft workspace</p>
          <h1 className="qs-page-heading">Build a workflow</h1>
          <p className="qs-helper mt-2 max-w-2xl">Connect agents, tools, and decisions. Validate the flow before sharing a version for review.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="qs-status-pill">{!persistenceReady ? 'Restoring draft…' : storageAvailable ? 'Saved on this device' : 'Device save unavailable'}</span>
          <button onClick={validateDraft} disabled={validating} className="qs-action-primary disabled:cursor-wait disabled:opacity-50">{validating ? 'Checking workflow…' : 'Validate workflow'}</button>
        </div>
      </header>

      <section aria-label="Add workflow step" className="qs-panel mb-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><h2 className="text-sm font-semibold text-quicksilver-signal">Add to your flow</h2><p className="qs-helper mt-1">Choose a step. It will be added to the end of the canvas.</p></div>
          <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto">
            {(['agent', 'tool', 'condition', 'loop', 'output'] as WorkflowNodeKind[]).map((kind) => <button key={kind} onClick={() => addNode(kind)} className="qs-action-secondary w-full sm:w-auto">＋ {nodeTitles[kind]}</button>)}
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(18rem,0.8fr)] 2xl:gap-7">
        <section aria-label="Workflow graph" className="qs-panel">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><div><p className="qs-eyebrow">Canvas</p><h2 className="mt-1 text-lg font-semibold text-quicksilver-signal">Your workflow</h2></div><span className="qs-status-pill">{nodes.length} steps <span aria-hidden="true">·</span> {edges.length} connections</span></div>
          <div className="mb-6 overflow-hidden rounded-xl border border-quicksilver-border bg-quicksilver-bg">
            <div className="flex items-center justify-between gap-3 border-b border-quicksilver-border px-4 py-3"><span className="text-sm font-medium text-quicksilver-signal">Workflow map</span><span className="text-xs text-quicksilver-accent">Auto-fit · updates as you edit</span></div>
            <div ref={diagramViewport} className="flex h-[min(56svh,44rem)] min-h-32 w-full items-center justify-center overflow-hidden p-3 sm:p-5" role="img" aria-label={`Workflow diagram with ${nodes.length} steps and ${edges.length} connections`}>
            <svg width={diagramSize.width || map.width} height={diagramSize.height || map.height} viewBox={`0 0 ${map.width} ${map.height}`} preserveAspectRatio="xMidYMid meet" className="block h-full w-full min-w-0">
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
          </div>
          <div className="mb-3 flex items-end justify-between gap-3"><div><p className="qs-eyebrow">Configuration</p><h3 className="mt-1 text-base font-semibold text-quicksilver-signal">Step settings</h3></div><span className="text-xs text-quicksilver-accent">Select a field to edit</span></div>
          <div className="space-y-3">
            {nodes.map((node, index) => (
              <div key={node.id} className="relative rounded-xl border border-quicksilver-border bg-quicksilver-bg p-4 sm:p-5">
                {index > 0 && <div aria-hidden="true" className="absolute -top-4 left-8 h-4 border-l border-quicksilver-accent/50" />}
                <div className="mb-3 flex flex-wrap items-center gap-3"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-quicksilver-accent/10 text-sm font-semibold text-quicksilver-signal">{index + 1}</span><span className="text-sm font-semibold text-quicksilver-signal">{nodeTitles[node.kind]}</span><span className="min-w-0 break-all rounded-full border border-quicksilver-border px-2 py-1 text-[11px] text-quicksilver-accent">{node.id}</span>{node.kind !== 'trigger' && <button onClick={() => removeNode(node.id)} aria-label={`Remove ${node.label}`} className="qs-action-secondary ml-auto min-h-9 px-3 py-1 text-xs">Remove step</button>}</div>
                <label className="block text-sm font-medium text-quicksilver-signal">Step name<input value={node.label} onChange={(event) => updateNode(node.id, { label: event.target.value })} className="qs-field mt-2 text-sm focus:border-quicksilver-accent focus:outline-none" /></label>
                {node.kind === 'condition' && <label className="mt-3 block text-xs text-quicksilver-accent">Condition<input value={node.config?.conditionExpression ?? ''} onChange={(event) => updateConfig(node.id, { conditionExpression: event.target.value })} placeholder={'$nqc.agent-1.reasoningScore >= 70'} className="qs-field mt-1" /><span className="mt-1 block text-[10px]">Use $input, $steps.&lt;node-id&gt;.&lt;field&gt;, or $nqc.&lt;agent-node-id&gt;.reasoningScore with comparisons or exists.</span></label>}
                {node.kind === 'loop' && node.config?.loop && <div className="mt-3 rounded-lg border border-quicksilver-border bg-quicksilver-panel p-3 sm:p-4"><p className="text-xs font-semibold text-quicksilver-signal">Bounded repeat</p><p className="mt-1 text-xs text-quicksilver-accent">Run an isolated, safety-governed workflow body until the condition becomes false. Iteration and wall-clock limits are mandatory; every tool approval is checked again each iteration.</p><div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="text-xs text-quicksilver-accent">Maximum iterations<input type="number" min={1} max={100} value={node.config.loop.maxIterations} onChange={(event) => updateConfig(node.id, { loop: { ...node.config!.loop!, maxIterations: Number(event.target.value) } })} className="qs-field mt-1" /></label><label className="text-xs text-quicksilver-accent">Time budget (milliseconds)<input type="number" min={1} max={300000} value={node.config.loop.maxDurationMs} onChange={(event) => updateConfig(node.id, { loop: { ...node.config!.loop!, maxDurationMs: Number(event.target.value) } })} className="qs-field mt-1" /></label></div><label className="mt-3 block text-xs text-quicksilver-accent">Continue while<input value={node.config.loop.continueWhile} onChange={(event) => updateConfig(node.id, { loop: { ...node.config!.loop!, continueWhile: event.target.value } })} placeholder="$input.iteration < 3" className="qs-field mt-1 font-mono" /><span className="mt-1 block text-[10px]">Use the data-only condition language with $input or $steps.&lt;body-node-id&gt;.&lt;field&gt;. A still-true condition at the iteration limit fails safely.</span></label><LoopBodyEditor key={`${node.id}:${node.config.loop.body.id}`} body={node.config.loop.body} onApply={(body) => updateConfig(node.id, { loop: { ...node.config!.loop!, body } })} /></div>}
                {node.kind === 'agent' && <div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="text-xs text-quicksilver-accent">Agent configuration key<input value={node.config?.agentId ?? ''} onChange={(event) => updateConfig(node.id, { agentId: event.target.value })} className="mt-1 w-full rounded border border-quicksilver-border bg-quicksilver-panel px-3 py-2 text-sm text-quicksilver-signal" /></label><ImpactField value={node.config?.impact ?? 'low'} onChange={(impact) => updateConfig(node.id, { impact })} /><ExecutionPolicyFields config={node.config ?? {}} onChange={(patch) => updateConfig(node.id, patch)} allowRetries />{(node.config?.impact === 'high' || node.config?.impact === 'critical') && <SafetyGates config={node.config} onChange={(patch) => updateConfig(node.id, patch)} />}</div>}
                {node.kind === 'tool' && <div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="text-xs text-quicksilver-accent">Tool contract key<input value={node.config?.toolId ?? ''} onChange={(event) => updateConfig(node.id, { toolId: event.target.value })} className="mt-1 w-full rounded border border-quicksilver-border bg-quicksilver-panel px-3 py-2 text-sm text-quicksilver-signal" /></label><ImpactField value={node.config?.impact ?? 'low'} onChange={(impact) => updateConfig(node.id, { impact })} /><ExecutionPolicyFields config={node.config ?? {}} onChange={(patch) => updateConfig(node.id, patch)} /> <label className="flex items-center gap-2 text-xs text-quicksilver-accent"><input type="checkbox" checked={node.config?.sideEffect ?? false} onChange={(event) => updateConfig(node.id, { sideEffect: event.target.checked, evaluationRequired: event.target.checked || node.config?.evaluationRequired, supervisorApprovalRequired: event.target.checked || node.config?.supervisorApprovalRequired })} /> Tool changes external state</label>{(node.config?.sideEffect || node.config?.impact === 'high' || node.config?.impact === 'critical') && <SafetyGates config={node.config} onChange={(patch) => updateConfig(node.id, patch)} />}</div>}
              </div>
            ))}
          </div>

          <div className="mt-6 border-t border-quicksilver-border pt-5">
            <details>
            <summary className="min-h-11 cursor-pointer text-sm font-semibold text-quicksilver-signal">Edit connections <span className="ml-2 text-xs font-normal text-quicksilver-accent">{edges.length} routes</span></summary>
            <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_0.7fr_auto]">
              <select aria-label="Connection source" value={connection.from} onChange={(event) => setConnection({ ...connection, from: event.target.value })} className="qs-field text-sm">{nodes.map((node) => <option key={node.id} value={node.id}>{node.label || node.id}</option>)}</select>
              <select aria-label="Connection destination" value={connection.to} onChange={(event) => setConnection({ ...connection, to: event.target.value })} className="qs-field text-sm">{nodes.map((node) => <option key={node.id} value={node.id}>{node.label || node.id}</option>)}</select>
              <select aria-label="Condition branch" value={connection.branch} onChange={(event) => setConnection({ ...connection, branch: event.target.value })} className="qs-field text-sm"><option value="">Unbranched</option><option value="true">True</option><option value="false">False</option></select>
              <button onClick={addConnection} className="qs-action-secondary">Connect</button>
            </div>
            <ul className="mt-3 space-y-2">{edges.map((edge) => <li key={edge.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-quicksilver-border px-3 py-2 text-sm text-quicksilver-accent"><span>{nodes.find((node) => node.id === edge.from)?.label ?? edge.from} <span aria-hidden="true">→</span> {nodes.find((node) => node.id === edge.to)?.label ?? edge.to}{edge.branch ? ` · ${edge.branch}` : ''}</span><button onClick={() => removeConnection(edge.id)} aria-label={`Remove connection ${edge.id}`} className="ml-auto text-xs font-medium text-quicksilver-accent underline decoration-transparent underline-offset-2 hover:text-red-300 hover:decoration-current">Remove</button></li>)}</ul>
            </details>
          </div>
        </section>

        <aside aria-label="Workflow tools" className="space-y-4 xl:sticky xl:top-24 xl:self-start">
          <section aria-labelledby="release-heading" className="qs-panel">
            <p className="qs-eyebrow">Release</p>
            <h2 id="release-heading" className="mt-1 text-lg font-semibold text-quicksilver-signal">Share and publish</h2>
            <p className="qs-helper mt-2">Create an immutable version, then move it through independent review before publication.</p><label className="mt-4 block text-sm font-medium text-quicksilver-signal">Review rationale <span className="font-normal text-quicksilver-accent">(10–500 characters)</span><textarea value={reviewRationale} onChange={(event) => setReviewRationale(event.target.value.slice(0, 500))} maxLength={500} rows={3} className="qs-field mt-2 text-sm" placeholder="Evidence and remaining concerns behind this review." /></label>
            <button onClick={savePlatformDraft} disabled={publicationBusy || !persistenceReady} className="qs-action-primary mt-4 w-full disabled:opacity-40">{publicationBusy ? 'Saving…' : `Save ${graph.id} v${graph.version}`}</button>
            {publicationNotice && <p role="status" className="mt-3 text-xs text-emerald-300">{publicationNotice}</p>}
            {publicationError && <p role="alert" className="mt-3 text-xs text-red-300">{publicationError}</p>}
            <details className="mt-4">
            <summary className="min-h-11 cursor-pointer text-sm font-semibold text-quicksilver-signal">Version history <span className="ml-2 text-xs font-normal text-quicksilver-accent">{publication.versions.length} versions</span></summary>
            <div className="mt-3 space-y-3">
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
            </details>
            {versionDiff && <section className="mt-4 rounded border border-quicksilver-accent/40 bg-quicksilver-bg p-3"><div className="flex items-center justify-between gap-2"><h3 className="font-mono text-[10px] uppercase tracking-widest">Version diff · v{versionDiff.fromVersion} → v{versionDiff.toVersion}</h3><button onClick={() => setVersionDiff(null)} className="text-[10px] text-quicksilver-accent">Clear</button></div><p className="mt-1 break-all font-mono text-[9px] text-quicksilver-accent">{versionDiff.fromDigest.slice(0, 16)}… → {versionDiff.toDigest.slice(0, 16)}…</p>{versionDiff.entryNodeChanged && <p className="mt-2 text-xs text-amber-200">Entry node changed.</p>}<ul className="mt-2 space-y-1 text-[10px] text-quicksilver-accent">{versionDiff.nodes.map((change) => <li key={`node-${change.id}`}>Node {change.change}: {change.id}{change.changedFields.length ? ` · ${change.changedFields.join(', ')}` : ''}</li>)}{versionDiff.edges.map((change) => <li key={`edge-${change.id}`}>Edge {change.change}: {change.id}{change.changedFields.length ? ` · ${change.changedFields.join(', ')}` : ''}</li>)}</ul>{versionDiff.riskChanges.length > 0 && <div className="mt-3 rounded border border-amber-800/60 p-2"><p className="font-mono text-[9px] uppercase tracking-widest text-amber-200">Safety-relevant changes</p><ul className="mt-1 space-y-1 text-[10px] text-amber-100">{versionDiff.riskChanges.map((change) => <li key={`${change.nodeId}-${change.field}`}>{change.nodeId} · {change.field}: {String(change.from)} → {String(change.to)}</li>)}</ul></div>}{versionDiff.nodes.length === 0 && versionDiff.edges.length === 0 && !versionDiff.entryNodeChanged && versionDiff.riskChanges.length === 0 && <p className="mt-2 text-xs text-emerald-200">No workflow graph changes detected.</p>}</section>}
            {publication.audit.length > 0 && <details className="mt-4"><summary className="flex min-h-11 cursor-pointer items-center font-mono text-[10px] uppercase tracking-widest text-quicksilver-accent">Publication history ({publication.audit.length})</summary><ol className="mt-2 space-y-2 text-[10px] text-quicksilver-accent">{publication.audit.slice(0, 12).map((event, index) => <li key={`${event.event}-${event.version}-${event.at}-${index}`}>{new Date(event.at).toLocaleString()} · {event.event} v{event.version} · {event.actorId}{event.detail ? ` · ${event.detail}` : ''}</li>)}</ol></details>}
          </section>
          <section className="qs-panel"><h2 className="text-base font-semibold text-quicksilver-signal">Safety check</h2><p className="qs-helper mt-2">Validation checks graph structure, branches, step limits, evaluation, and supervisor approval requirements.</p><input ref={fileInput} type="file" accept=".json,application/json" onChange={importDraft} className="hidden" /><button onClick={() => fileInput.current?.click()} disabled={!persistenceReady} className="qs-action-secondary mb-2 w-full disabled:opacity-40">Import workflow JSON</button><button onClick={exportDraft} className="qs-action-secondary w-full">Export workflow draft</button><button onClick={validateDraft} disabled={validating} className="qs-action-primary mt-4 w-full disabled:opacity-40">{validating ? 'Checking…' : 'Validate workflow'}</button>{error && <p role="alert" className="mt-3 text-xs text-red-300">{error}</p>}{validation && <div className={`mt-4 rounded border p-3 ${validation.valid ? 'border-emerald-800 bg-emerald-950/20' : 'border-amber-800 bg-amber-950/20'}`}><p className="font-mono text-xs uppercase tracking-widest">{validation.valid ? 'Ready for review' : 'Needs changes'}</p>{validation.errors.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-quicksilver-accent">{validation.errors.map((item) => <li key={item}>{item}</li>)}</ul>}{validation.valid && <p className="mt-2 text-xs text-quicksilver-accent">Topological order: {validation.topologicalOrder.join(' → ')}</p>}</div>}</section>
          <section className="qs-panel"><h2 className="text-base font-semibold text-quicksilver-signal">Run a published workflow</h2><p className="qs-helper mt-2">Running a workflow starts from the chat, so it is one conversation with one audit trail. Ask Quicksilver to run it and press the card it offers.</p><button type="button" onClick={() => window.dispatchEvent(new Event('quicksilver:open-chat'))} className="qs-action-secondary mt-4 w-full">Open the chat</button></section>          <details className="mt-4"><summary className="flex min-h-11 cursor-pointer items-center font-mono text-[10px] uppercase tracking-widest text-quicksilver-accent">Execution history ({executions.length})</summary>{executionHistoryError ? <p className="mt-2 text-xs text-amber-200">{executionHistoryError}</p> : <ol className="mt-2 space-y-2 text-[10px] text-quicksilver-accent">{executions.map((execution) => <li key={execution.runId}>{new Date(execution.completedAt).toLocaleString()} · v{execution.version} · {execution.status} · {execution.durationMs} ms · {execution.evaluationCount} evaluations · {execution.requestedBy}</li>)}</ol>}</details><section className="rounded border border-quicksilver-border bg-quicksilver-panel p-5"><h2 className="font-mono text-xs uppercase tracking-widest text-quicksilver-accent">Run preview</h2><p className="mt-2 text-xs leading-5 text-quicksilver-accent">Simulation only: agent results are placeholders. No model, live evaluator, tool, or supervisor approval is called, and no external action can run.</p><button onClick={previewWorkflow} disabled={!persistenceReady} className="mt-4 w-full rounded border border-quicksilver-quicksilver bg-quicksilver-quicksilver/5 px-4 py-3 font-mono text-xs uppercase tracking-widest text-quicksilver-signal hover:bg-quicksilver-quicksilver/15 disabled:opacity-40">Preview workflow path</button>{simulation?.graphKey === JSON.stringify(graph) && <div role="status" className="mt-4 rounded border border-quicksilver-border p-3"><p className="font-mono text-xs uppercase tracking-widest">Simulation · {simulation.result.status}</p>{simulation.result.error && <p className="mt-2 text-xs text-amber-200">{simulation.result.error}</p>}<ul className="mt-3 space-y-2 text-xs text-quicksilver-accent">{simulation.result.steps.map((step) => <li key={step.nodeId}><span className="font-mono">{nodes.find((node) => node.id === step.nodeId)?.label ?? step.nodeId}</span> · {step.status}{step.safetyDecision ? ` · ${step.safetyDecision}` : ''}{step.detail ? <span className="block">{step.detail}</span> : null}</li>)}</ul><p className="mt-3 text-[10px] leading-4 text-quicksilver-accent">A preview is not a live evaluation or approval. Tool steps stop before dispatch.</p></div>}</section>          <section className="rounded border border-quicksilver-border bg-quicksilver-panel p-5"><h2 className="font-mono text-xs uppercase tracking-widest text-quicksilver-accent">What happens next</h2><p className="mt-2 text-xs leading-5 text-quicksilver-accent">Published versions can run through the gated read-only path and their release and run history is visible above. Hosted execution, team workspaces, scheduled deployment, and effectful tools remain in progress.</p></section>
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
