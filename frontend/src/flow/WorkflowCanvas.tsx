import {
  ApartmentOutlined, AppstoreOutlined, CloseOutlined, DeploymentUnitOutlined, FullscreenExitOutlined,
  FullscreenOutlined, RadarChartOutlined, RedoOutlined, UndoOutlined,
} from '@ant-design/icons'
import {
  Background, BaseEdge, ControlButton, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow,
  getBezierPath, useStore,
  type Connection, type Edge, type EdgeProps, type Node, type NodeProps, type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Alert, Button, Empty, Tabs, Tooltip } from 'antd'
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { NodeResultView, statusLabel } from '../components/RunEvidence'
import type { ApiDefinition, Artifact, FlowRun, WorkflowDefinition, WorkflowNode } from '../lib/api'
import NodeInspector from './NodeInspector'
import WorkflowEdgeInspector from './WorkflowEdgeInspector'
import WorkflowNodeEditSession from './WorkflowNodeEditSession'
import WorkflowSettingsEditor from './WorkflowSettingsEditor'
import { WorkflowEdgeActions, WorkflowNodeActions, type NodeInspectionMode } from './WorkflowSelectionActions'
import type { GraphConnectionInput } from './editor/editor-types'
import { analyzeGraph, resolveEffectiveNodeType } from './editor/graph-analysis'
import { addControlBlock, controlCapabilityLabel, type ControlBlockKind } from './editor/control-blocks'
import { connectGraphNodes, reconnectGraphEdge, swapBranches } from './editor/graph-commands'
import { dataReferences, nodePresentation, type RegionPreview } from './editor/node-presentation'
import { useWorkflowEditor } from './editor/use-workflow-editor'
import { useDraftSession } from '../features/drafts/draft-session'
import { useNodeSelectionGuard } from './editor/use-node-selection-guard'
import { addApiNode, addTypedNode, autoLayoutWorkflow, insertNodeOnEdge, pasteNode, workflowNodeSize, type PaletteNodeType } from './workflow-graph'
import WorkflowNodeIcon, { NodeNoteIndicator } from './WorkflowNodeIcon'
import WorkflowNodeLibrary, { NODE_DRAG_FORMAT, nodeChoice, type NodeChoice } from './WorkflowNodeLibrary'
import WorkflowNodeRelations from './WorkflowNodeRelations'
import WorkflowRunTimeline from './WorkflowRunTimeline'
import { useCanvasHotkeys } from './editor/use-canvas-hotkeys'
import './workflow-editor.css'

type NodeData = {
  label: string
  note?: string
  nodeType: WorkflowNode['type']
  typeLabel: string
  control?: string
  status: string
  endpoint?: { method: string; path: string; statusCode?: number }
  summary: string
  regions: RegionPreview[]
  inspectionMode: NodeInspectionMode
  canCopy: boolean
  canDelete: boolean
  onConfigure: () => void
  onCopy: () => void
  onDelete: () => void
}
type CanvasNode = Node<NodeData, 'workflowNode'>
type CanvasEdge = Edge<{
  branch: 'true' | 'false' | null
  editable: boolean
  onConfigure: () => void
  onDelete: () => void
}, 'workflowEdge'>

const nodeTypes = { workflowNode: WorkflowNodeCard }
const edgeTypes = { workflowEdge: WorkflowCanvasEdge }
const fitOptions = { padding: 0.14, maxZoom: 1.2 }
const canvasLabels = {
  'controls.zoomIn.ariaLabel': '放大',
  'controls.zoomOut.ariaLabel': '缩小',
  'controls.fitView.ariaLabel': '适应画布',
  'controls.interactive.ariaLabel': '切换画布交互',
  'minimap.ariaLabel': '流程缩略图',
}
const labels: Record<WorkflowNode['type'], string> = {
  api: 'HTTP 请求', start: '开始', end: '结束', extract: '提取变量', assert: '断言校验',
  condition: '条件判断', delay: '等待', capability: '流程控制',
}

type Props = {
  definition: WorkflowDefinition
  workflowId: string
  apis: ApiDefinition[]
  artifacts: Artifact[]
  environment?: string
  run?: FlowRun
  view: 'edit' | 'run'
  runDefinition?: WorkflowDefinition
  modeControls: ReactNode
  onChange: (definition: WorkflowDefinition) => void
}

export default function WorkflowCanvas({
  definition, workflowId, apis, artifacts, environment, run, view, runDefinition, modeControls, onChange,
}: Props) {
  const editing = view === 'edit'
  const editor = useWorkflowEditor(definition, editing, onChange)
  const current = editing ? editor.definition : (runDefinition ?? definition)
  const [apiId, setApiId] = useState<string>()
  const [libraryOpen, setLibraryOpen] = useState(() => window.matchMedia('(min-width: 1000px)').matches)
  const [focus, setFocus] = useState(false)
  const [relations, setRelations] = useState(false)
  const [runSelection, setRunSelection] = useState<{ runId: string; nodeId: string }>()
  const scope = `workflow:${workflowId}:`
  const session = useDraftSession()
  const guard = useNodeSelectionGuard(session, scope, editing)
  const canvas = useRef<ReactFlowInstance<CanvasNode, CanvasEdge> | null>(null)
  const canvasHost = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!canvasHost.current) return
    let frame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => void canvas.current?.fitView(fitOptions))
    })
    observer.observe(canvasHost.current)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [])
  const clipboard = useRef<WorkflowNode | null>(null)
  const selectedNode = current.nodes.find((node) => editor.selection?.kind === 'node' && editor.selection.id === node.id)
  const selectedEdge = current.edges.find((edge) => editor.selection?.kind === 'edge' && editor.selection.id === edge.id)
  const runNodes = new Map(run?.nodes.map((item) => [item.node_id, item]))
  const execution = run && (
    (runSelection?.runId === run.id ? runNodes.get(runSelection.nodeId) : undefined) ??
    run.nodes.find((item) => item.status === 'failed') ??
    run.nodes.find((item) => item.result?.observations.length) ?? run.nodes[0]
  )
  const diagnostics = editing ? analyzeGraph(current) : []
  const activeApi = apis.find((api) => api.id === apiId) ?? apis[0]
  const activeNodeId = editing ? selectedNode?.id : execution?.node_id
  const inspecting = editing ? Boolean(selectedNode || selectedEdge) : Boolean(execution)

  function inspect(kind: 'node' | 'edge', id: string) {
    if (!editing) {
      if (run && kind === 'node') setRunSelection({ runId: run.id, nodeId: id })
      return
    }
    if (editor.selection?.kind !== kind || editor.selection.id !== id) mutate(() => editor.click(kind, id))
    setFocus(false)
  }
  function fitCanvas() {
    requestAnimationFrame(() => void canvas.current?.fitView({ ...fitOptions, duration: 160 }))
  }
  function locateNode(id: string) {
    inspect('node', id)
    const node = canvas.current?.getNode(id)
    if (node) {
      const { x, y } = node.position
      const zoom = canvas.current?.getZoom() ?? 1
      const { width, height } = workflowNodeSize(node.data.nodeType)
      requestAnimationFrame(() => void canvas.current?.setCenter(
        x + width / 2, y + height / 2,
        { zoom, duration: 180 },
      ))
    }
  }
  function add(type: NodeChoice, position?: WorkflowNode['position']) {
    const base = editor.latest.current.definition
    let next: WorkflowDefinition
    if (type === 'api') {
      if (!activeApi) return
      next = addApiNode(base, activeApi.id)
    } else if (type.startsWith('control.')) {
      next = addControlBlock(base, type.slice(8) as ControlBlockKind)
    } else {
      next = addTypedNode(base, type as PaletteNodeType)
    }
    const newNode = next.nodes.at(-1)!
    if (position) {
      next = { ...next, nodes: next.nodes.map((item) => item.id === newNode.id ? { ...item, position } : item) }
    } else {
      const terminal = base.nodes.filter((node) => node.type === 'end')
      const incoming = terminal.length === 1 ? base.edges.filter((edge) => edge.target === terminal[0].id) : []
      const insertEdge = selectedEdge ?? (incoming.length === 1 && incoming[0].condition === null ? incoming[0] : undefined)
      if (insertEdge && type !== 'condition' && type !== 'end') {
        next = insertNodeOnEdge(next, newNode.id, insertEdge.id) ?? next
      }
    }
    editor.commit(next, { kind: 'node', id: newNode.id })
    if (!position) fitCanvas()
  }
  function dragOver(event: DragEvent<HTMLDivElement>) {
    if (!editing || !event.dataTransfer.types.includes(NODE_DRAG_FORMAT)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }
  function drop(event: DragEvent<HTMLDivElement>) {
    if (!editing) return
    const type = event.dataTransfer.getData(NODE_DRAG_FORMAT)
    if (!nodeChoice(type)) return
    event.preventDefault()
    const position = canvas.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY })
    if (position) mutate(() => add(type, position))
  }
  function mutate(action: () => void) { void guard.request().then((proceed) => { if (proceed) action() }) }
  const hotkeys = useCanvasHotkeys({
    delete: () => mutate(editor.deleteSelection),
    undo: () => mutate(editor.undo),
    redo: () => mutate(editor.redo),
    copy: () => { if (selectedNode && !['start', 'end'].includes(selectedNode.type)) clipboard.current = structuredClone(selectedNode) },
    paste: () => mutate(() => { if (clipboard.current) copy(clipboard.current) }),
    focus: () => mutate(() => setFocus((value) => !value)),
    escape: () => mutate(() => { setFocus(false); editor.select(null) }),
    add: () => setLibraryOpen((value) => !value),
  }, !editing)
  function connection(value: Connection): GraphConnectionInput {
    const branch = value.sourceHandle === 'true' || value.sourceHandle === 'false' ? value.sourceHandle : null
    return { edgeId: crypto.randomUUID(), sourceId: value.source, targetId: value.target, branch }
  }
  function copy(node: WorkflowNode) {
    const base = editor.latest.current.definition
    const next = pasteNode(base, node)
    editor.commit(next, { kind: 'node', id: next.nodes.at(-1)!.id })
  }
  const nodes: CanvasNode[] = current.nodes.map((node) => {
    const type = resolveEffectiveNodeType(node)
    const result = editing ? undefined : runNodes.get(node.id)
    const presentation = nodePresentation(node, current, apis)
    const { width, height } = workflowNodeSize(type)
    const attempt = type === 'api' ? result?.result?.observations.at(-1) : undefined
    return {
      id: node.id, type: 'workflowNode',
      initialWidth: width, initialHeight: height,
      style: { width, height },
      position: editor.positions.get(node.id) ?? node.position,
      selected: activeNodeId === node.id,
      data: {
        ...presentation,
        label: node.name,
        note: node.note,
        nodeType: type,
        typeLabel: controlCapabilityLabel(node.capability_id) ?? labels[type],
        control: node.capability_id?.split('.').at(-1),
        status: result?.status ?? 'pending',
        endpoint: attempt ? { method: attempt.request.method, path: attempt.request.url, statusCode: attempt.response?.status_code } : presentation.endpoint,
        inspectionMode: editing ? 'configuration' : 'execution',
        canCopy: editing && type !== 'start' && type !== 'end',
        canDelete: editing && type !== 'start' && (type !== 'end' || current.nodes.filter((item) => item.type === 'end').length > 1),
        onConfigure: () => inspect('node', node.id),
        onCopy: () => mutate(() => copy(node)),
        onDelete: () => mutate(() => { editor.click('node', node.id); editor.deleteSelection() }),
      },
    }
  })
  const edges: CanvasEdge[] = current.edges.map((edge) => ({
    id: edge.id, source: edge.source, target: edge.target, type: 'workflowEdge',
    sourceHandle: edge.condition ?? 'out',
    selected: editing && selectedEdge?.id === edge.id,
    markerEnd: { type: MarkerType.ArrowClosed, width: 15, height: 15, color: edgeTone(edge.condition).stroke },
    label: edge.condition === 'true' ? '成立' : edge.condition === 'false' ? '否则' : undefined,
    data: {
      branch: edge.condition, editable: editing,
      onConfigure: () => inspect('edge', edge.id),
      onDelete: () => mutate(() => { editor.click('edge', edge.id); editor.deleteSelection() }),
    },
  }))
  if (relations && editing) {
    const ids = new Set(current.nodes.map((node) => node.id))
    for (const reference of dataReferences(current)) {
      if (!ids.has(reference.source) || !ids.has(reference.target)) continue
      const source = current.nodes.find((node) => node.id === reference.source)
      edges.push({
        ...reference,
        type: 'workflowEdge',
        sourceHandle: source && resolveEffectiveNodeType(source) === 'condition' ? 'true' : 'out',
        selectable: false, reconnectable: false, focusable: false,
        className: 'workflow-data-reference',
        style: { stroke: 'var(--ft-icon-extract)', strokeDasharray: '5 5' },
      })
    }
  }

  return (
    <div className="workflow-editor lite-flow-editor" data-view={view} data-focus={focus}>
      {guard.dialog}
      <div className="canvas-toolbar">
        <div className="canvas-mode-controls">{modeControls}</div>
        <div className="canvas-tools" role="group" aria-label="画布工具">
          {editing && <>
            <Button type="text" size="small" icon={<AppstoreOutlined />}
              className="canvas-tools-toggle" aria-label="节点库" aria-pressed={libraryOpen && !focus}
              onClick={() => { setFocus(false); setLibraryOpen(focus || !libraryOpen) }}>节点库</Button>
            <div className="canvas-tool-group">
              <Tooltip placement="bottom" title="撤销（Ctrl/⌘ + Z）"><Button type="text" size="small" aria-label="撤销" icon={<UndoOutlined />} disabled={!editor.past.length} onClick={() => mutate(editor.undo)} /></Tooltip>
              <Tooltip placement="bottom" title="重做（Ctrl/⌘ + Shift + Z）"><Button type="text" size="small" aria-label="重做" icon={<RedoOutlined />} disabled={!editor.future.length} onClick={() => mutate(editor.redo)} /></Tooltip>
              <Tooltip placement="bottom" title="自动布局">
                <Button type="text" size="small" aria-label="自动布局" icon={<ApartmentOutlined />} onClick={() => mutate(() => {
                  editor.commit(autoLayoutWorkflow(editor.latest.current.definition))
                  fitCanvas()
                })} />
              </Tooltip>
            </div>
            <Button type="text" size="small" icon={<DeploymentUnitOutlined />} className="canvas-tools-toggle"
              aria-pressed={relations} onClick={() => setRelations(!relations)}>数据引用</Button>
            <WorkflowSettingsEditor definition={current} editable historical={false}
              beforeOpen={guard.request} onChange={(next) => editor.commit(next)} />
            <Tooltip placement="bottom" title={focus ? '退出专注' : '专注模式'}>
              <Button type="text" size="small" aria-label={focus ? '退出专注' : '专注模式'} aria-pressed={focus}
                icon={focus ? <FullscreenExitOutlined /> : <FullscreenOutlined />} onClick={() => mutate(() => setFocus(!focus))} />
            </Tooltip>
          </>}
        </div>
      </div>
      <div className="lite-flow-grid" data-inspector={inspecting && !focus} data-library={editing && libraryOpen && !focus}>
        {editing && !focus && libraryOpen && <WorkflowNodeLibrary apis={apis} apiId={activeApi?.id} setApiId={setApiId}
          onClose={() => setLibraryOpen(false)} onAdd={(type) => mutate(() => add(type))} />}
        <div className="lite-flow-center">
          <div ref={canvasHost} className="workflow-canvas lite-canvas" aria-label="流程画布" tabIndex={0}
            onKeyDown={hotkeys} onDragOver={dragOver} onDrop={drop}>
            {editing && (editor.message || diagnostics[0]) && (
              <div className="canvas-diagnostic" data-valid={!diagnostics.length} role="status"
                title={editor.message ?? diagnostics[0]?.message}>
                {editor.message ?? diagnostics[0]?.message}
              </div>
            )}
            <ReactFlow<CanvasNode, CanvasEdge>
              nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
              fitView fitViewOptions={fitOptions} onInit={(instance) => { canvas.current = instance }}
              minZoom={0.15} maxZoom={1.7} deleteKeyCode={null} ariaLabelConfig={canvasLabels}
              nodesDraggable={editing} nodesConnectable={editing} edgesReconnectable={editing}
              onConnect={(value) => { if (editing) editor.accept(connectGraphNodes(editor.latest.current.definition, connection(value))) }}
              onReconnect={(edge, value) => { if (editing) editor.accept(reconnectGraphEdge(editor.latest.current.definition, edge.id, connection(value))) }}
              onNodeClick={(_, node) => inspect('node', node.id)}
              onEdgeClick={(_, edge) => inspect('edge', edge.id)}
              onPaneClick={() => { if (editing) mutate(() => editor.select(null)) }}
              onNodeDragStart={editor.beginDrag}
              onNodesChange={(changes) => {
                for (const change of changes) {
                  if (change.type === 'position' && change.position)
                    editor.positionsChanged([{ id: change.id, position: change.position }], change.dragging)
                }
              }}
            >
              <Background gap={20} size={1.2} color="var(--canvas-grid-dot)" />
              <CanvasNavigation editing={editing} />
            </ReactFlow>
          </div>
          {!editing && run && <WorkflowRunTimeline key={run.id} run={run} selected={execution?.node_id}
            onSelect={(id) => locateNode(id)} />}
        </div>
        {inspecting && !focus && (
          <aside className="lite-flow-inspector" aria-label={editing ? '流程检查器' : '节点运行详情'}>
            <header className="pane-heading">
              <h2>{editing ? (selectedEdge ? '连线配置' : '节点配置') : '节点运行详情'}</h2>
              {editing && <Button type="text" size="small" icon={<CloseOutlined />} aria-label="关闭配置" onClick={() => mutate(() => editor.select(null))} />}
            </header>
            <div className="lite-inspector-content">
              {!editing && execution && <>
                <RunNodeNote definition={current} nodeId={execution.node_id} />
                <NodeResultView key={execution.node_id} item={execution} />
              </>}
              {editing && selectedNode && (
                <Tabs key={selectedNode.id} size="small" items={[
                  { key: 'config', label: '配置', forceRender: true, children: (
                    <WorkflowNodeEditSession key={selectedNode.id} scope={scope} node={selectedNode} definition={current} editable
                      onChange={(next) => editor.commit(next)}>
                      {(node, update) => (
                        <NodeInspector node={node} definition={current} apis={apis} artifacts={artifacts} environment={environment} editable
                          onUpdate={(next) => update({
                            ...current, nodes: current.nodes.map((item) => item.id === next.id ? next : item),
                          }, 'node')}
                          onRegionUpdate={(next) => update({
                            ...current, regions: current.regions?.map((item) => item.id === next.id ? next : item),
                          }, 'regions')}
                          onStructureChange={(next) => update(next, 'structure')} />
                      )}
                    </WorkflowNodeEditSession>
                  ) },
                  { key: 'data', label: '输入 / 输出', children: (
                    <WorkflowNodeRelations node={selectedNode} definition={current} onLocateNode={locateNode} />
                  ) },
                ]} />
              )}
              {editing && selectedEdge && <WorkflowEdgeInspector
                edge={selectedEdge} definition={current} editable
                onUpdate={(edge) => editor.commit({
                  ...current, edges: current.edges.map((item) => item.id === edge.id ? edge : item),
                })}
                onDelete={() => editor.deleteSelection()}
                onSwap={() => editor.accept(swapBranches(current, selectedEdge.source))}
              />}
            </div>
          </aside>
        )}
      </div>
      {!editing && run?.error && <Alert type="error" title={run.error} />}
      {!editing && !run && <Empty className="workflow-no-run" description="运行流程后查看节点状态" />}
    </div>
  )
}

function RunNodeNote({ definition, nodeId }: { definition: WorkflowDefinition; nodeId: string }) {
  const node = definition.nodes.find((item) => item.id === nodeId)
  if (!node?.note?.trim()) return null
  return <section className="flow-run-node-note" aria-label="节点备注">
    <strong>节点备注</strong><p>{node.note}</p>
  </section>
}

function WorkflowNodeCard({ data, selected }: NodeProps<CanvasNode>) {
  const terminal = data.nodeType === 'end'
  const start = data.nodeType === 'start'
  const boundary = terminal || start
  const regionDetails = data.regions.map(({ label, steps }) => `${label}：${steps.join(' → ') || '尚未配置步骤'}`)
  const internalSteps = data.regions.reduce((total, region) => total + region.steps.length, 0)
  const endpoint = data.endpoint
  const path = endpoint?.path.replace(/^(?:https?:)?\/\/[^/?#]+/i, '').replace(/^(?=[?#])/, '/') || '/'
  return (
    <>
      <WorkflowNodeActions
        visible={Boolean(selected)}
        inspectionMode={data.inspectionMode}
        editable={Boolean(data.canDelete)}
        canCopy={Boolean(data.canCopy)}
        onConfigure={data.onConfigure ?? (() => undefined)}
        onCopy={data.onCopy ?? (() => undefined)}
        onDelete={data.onDelete ?? (() => undefined)}
      />
      <div className="flow-node" data-node-type={data.nodeType} data-boundary={boundary} data-status={data.status}>
        {!start && <Handle type="target" position={Position.Left} />}
        <div className="flow-node-heading">
          <WorkflowNodeIcon type={data.nodeType} control={data.control} />
          <strong className="flow-node-name" title={data.label}>
            {data.label}
          </strong>
          <NodeNoteIndicator note={data.note} />
          {data.inspectionMode === 'execution' && (
            <span className="flow-node-state" title={endpoint?.statusCode ? `HTTP ${endpoint.statusCode}` : undefined}>
              {statusLabel[data.status] ?? data.status}
            </span>
          )}
        </div>
        {!boundary && (endpoint ? (
          <div className="flow-node-detail flow-node-endpoint" title={`${endpoint.method} ${endpoint.path}`}>
            <span className="http-method" data-method={endpoint.method}>{endpoint.method}</span>
            <code>{path}</code>
          </div>
        ) : (
          <div className="flow-node-detail">
            <span className="flow-node-detail-text" title={data.summary || data.typeLabel}>{data.summary || data.typeLabel}</span>
            {regionDetails.length > 0 && <span className="flow-node-step-count" title={regionDetails.join('\n')}>{internalSteps} 步</span>}
          </div>
        ))}
        {!terminal &&
          (data.nodeType === 'condition' ? (
            <>
              <Handle type="source" id="true" position={Position.Right} aria-label="成立出口" />
              <Handle type="source" id="false" position={Position.Right} aria-label="否则出口" />
            </>
          ) : (
            <Handle type="source" id="out" position={Position.Right} />
          ))}
      </div>
    </>
  )
}

function CanvasNavigation({ editing }: { editing: boolean }) {
  const zoom = useStore((state) => Math.round(state.transform[2] * 100))
  const [overview, setOverview] = useState(false)
  return (
    <>
      <Controls position="bottom-right" orientation="horizontal" fitViewOptions={fitOptions}
        showInteractive={editing} aria-label="画布导航">
        <span className="canvas-zoom" aria-label={`缩放 ${zoom}%`}>{zoom}%</span>
        <ControlButton aria-label="流程缩略图" title="流程缩略图" aria-pressed={overview}
          onClick={() => setOverview(!overview)}><RadarChartOutlined /></ControlButton>
      </Controls>
      {overview && <MiniMap<CanvasNode> position="bottom-right" nodeBorderRadius={10} pannable zoomable />}
    </>
  )
}

function edgeTone(branch: NonNullable<CanvasEdge['data']>['branch']) {
  if (branch === 'true') return { stroke: 'var(--canvas-branch-true)', background: 'var(--ft-success-bg)' }
  if (branch === 'false') return { stroke: 'var(--canvas-branch-false)', background: 'var(--ft-warning-bg)' }
  return { stroke: 'var(--canvas-edge)', background: 'var(--ft-surface)' }
}

function WorkflowCanvasEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  label,
  selected,
  data,
}: EdgeProps<CanvasEdge>) {
  const [path, centerX, centerY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  })
  const tone = edgeTone(data?.branch ?? null)
  const stroke = selected ? 'var(--ft-brand)' : tone.stroke
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={{ stroke, ...style }}
        label={label} labelX={centerX} labelY={centerY}
        labelStyle={{ fill: data ? tone.stroke : 'var(--ft-icon-extract)' }}
        labelBgStyle={{ fill: tone.background, stroke: 'var(--ft-border-subtle)' }}
        labelBgPadding={[6, 4]} labelBgBorderRadius={7} />
      {data && (
        <WorkflowEdgeActions
          edgeId={id}
          x={centerX}
          y={centerY}
          visible={Boolean(selected)}
          branch={data.branch}
          editable={data.editable}
          onConfigure={data.onConfigure}
          onDelete={data.onDelete}
        />
      )}
    </>
  )
}
