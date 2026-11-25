import {
  AimOutlined, ApiOutlined, ApartmentOutlined, AppstoreOutlined, BranchesOutlined, CheckCircleOutlined,
  ClockCircleOutlined, ExportOutlined, FlagOutlined, FullscreenExitOutlined, FullscreenOutlined,
  PlayCircleOutlined, RedoOutlined, UndoOutlined,
} from '@ant-design/icons'
import {
  Background, BaseEdge, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow, getBezierPath,
  type Connection, type Edge, type EdgeProps, type Node, type NodeProps, type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Alert, Button, Checkbox, Empty, Space, Tabs, Tooltip } from 'antd'
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
import { addApiNode, addTypedNode, autoLayoutWorkflow, insertNodeOnEdge, pasteNode, type PaletteNodeType } from './workflow-graph'
import WorkflowNodeLibrary, { NODE_DRAG_FORMAT, nodeChoice, type NodeChoice } from './WorkflowNodeLibrary'
import WorkflowNodeRelations from './WorkflowNodeRelations'
import WorkflowRunTimeline from './WorkflowRunTimeline'
import { useCanvasHotkeys } from './editor/use-canvas-hotkeys'
import './workflow-editor.css'

type NodeData = {
  label: string
  nodeType: WorkflowNode['type']
  typeLabel: string
  status: string
  runtimeLabel: string
  summary?: string
  regions?: RegionPreview[]
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
const fitOptions = { padding: 0.13, maxZoom: 1.12 }
const labels: Record<WorkflowNode['type'], string> = {
  api: '接口', start: '开始', end: '结束', extract: '提取变量', assert: '断言',
  condition: '条件分支', delay: '等待', capability: '控制块',
}
const nodeIcons: Partial<Record<WorkflowNode['type'], ReactNode>> = {
  start: <PlayCircleOutlined />, end: <FlagOutlined />, extract: <ExportOutlined />,
  assert: <CheckCircleOutlined />, condition: <BranchesOutlined />, delay: <ClockCircleOutlined />,
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
      requestAnimationFrame(() => void canvas.current?.setCenter(
        x + (node.measured?.width ?? 220) / 2, y + (node.measured?.height ?? 90) / 2,
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
    const view = nodePresentation(node, current, apis)
    return {
      id: node.id, type: 'workflowNode',
      initialWidth: 196,
      initialHeight: (editing ? 80 : 109) + 50 * view.regions.length,
      position: editor.positions.get(node.id) ?? node.position,
      selected: activeNodeId === node.id,
      data: {
        label: node.name, nodeType: type, typeLabel: controlCapabilityLabel(node.capability_id) ?? labels[type],
        status: result?.status ?? 'pending', runtimeLabel: result?.attempts ? `${result.attempts} 次` : '',
        ...view,
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
    markerEnd: { type: MarkerType.ArrowClosed },
    label: edge.condition === 'true' ? '真' : edge.condition === 'false' ? '假' : undefined,
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
        style: { stroke: 'var(--ft-brand-decorative)', strokeDasharray: '5 5' },
      })
    }
  }

  return (
    <div className="workflow-editor lite-flow-editor" data-view={view} data-focus={focus}>
      {guard.dialog}
      <div className="canvas-toolbar">
        <div className="canvas-mode-controls">{modeControls}</div>
        <Space wrap size={5} className="canvas-tools" aria-label="画布工具">
          {editing && <>
            <Button type="text" size="small" icon={<AppstoreOutlined />}
              className="canvas-tools-toggle" aria-label="节点库" aria-pressed={libraryOpen && !focus}
              onClick={() => { setFocus(false); setLibraryOpen(focus || !libraryOpen) }}>节点库</Button>
            <Tooltip title="撤销（Ctrl/⌘ + Z）"><Button type="text" size="small" aria-label="撤销" icon={<UndoOutlined />} disabled={!editor.past.length} onClick={() => mutate(editor.undo)} /></Tooltip>
            <Tooltip title="重做（Ctrl/⌘ + Shift + Z）"><Button type="text" size="small" aria-label="重做" icon={<RedoOutlined />} disabled={!editor.future.length} onClick={() => mutate(editor.redo)} /></Tooltip>
            <Tooltip title="自动布局">
              <Button type="text" size="small" aria-label="自动布局" icon={<ApartmentOutlined />} onClick={() => mutate(() => {
                editor.commit(autoLayoutWorkflow(editor.latest.current.definition))
                fitCanvas()
              })} />
            </Tooltip>
          </>}
          <Tooltip title="适应画布"><Button type="text" size="small" aria-label="适应画布" icon={<AimOutlined />} onClick={fitCanvas} /></Tooltip>
          {editing && <>
            <Checkbox checked={relations} onChange={(event) => setRelations(event.target.checked)}>数据引用</Checkbox>
            <WorkflowSettingsEditor definition={current} editable historical={false}
              beforeOpen={guard.request} onChange={(next) => editor.commit(next)} />
            <Tooltip title={focus ? '退出专注' : '专注模式'}>
              <Button type="text" size="small" aria-label={focus ? '退出专注' : '专注模式'} aria-pressed={focus}
                icon={focus ? <FullscreenExitOutlined /> : <FullscreenOutlined />} onClick={() => mutate(() => setFocus(!focus))} />
            </Tooltip>
          </>}
        </Space>
      </div>
      <div className="lite-flow-grid" data-inspector={inspecting && !focus} data-library={editing && libraryOpen && !focus}>
        {editing && !focus && libraryOpen && <WorkflowNodeLibrary apis={apis} apiId={activeApi?.id} setApiId={setApiId}
          open={libraryOpen} onAdd={(type) => mutate(() => add(type))} />}
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
              minZoom={0.15} maxZoom={1.7} deleteKeyCode={null}
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
              <Background gap={22} size={1.15} color="var(--ft-grid-dot)" />
              <Controls position="bottom-right" showInteractive={editing} />
              <MiniMap position="bottom-left" style={{ width: 180, height: 112 }} pannable zoomable />
            </ReactFlow>
          </div>
          {!editing && run && <WorkflowRunTimeline key={run.id} run={run} selected={execution?.node_id}
            onSelect={(id) => locateNode(id)} />}
        </div>
        {inspecting && !focus && (
          <aside className="lite-flow-inspector" aria-label={editing ? '流程检查器' : '节点运行详情'}>
            <header className="pane-heading">
              <h2>{editing ? (selectedEdge ? '连线配置' : '节点配置') : '节点运行详情'}</h2>
              {editing && <Button type="text" size="small" onClick={() => mutate(() => editor.select(null))}>关闭</Button>}
            </header>
            <div className="lite-inspector-content">
              {!editing && execution && <NodeResultView key={execution.node_id} item={execution} />}
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

function WorkflowNodeCard({ data, selected }: NodeProps<CanvasNode>) {
  const terminal = data.nodeType === 'end'
  const start = data.nodeType === 'start'
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
      <div className={`flow-node flow-node-${data.nodeType} is-${data.status}`}>
        {!start && <Handle type="target" position={Position.Left} />}
        <div className="flow-node-heading">
          <span className="flow-node-icon">{(nodeIcons[data.nodeType] ?? <ApiOutlined />)}</span>
          <span className="flow-node-copy">
            <strong>{data.label}</strong>
            <small>{data.typeLabel}</small>
          </span>
        </div>
        <div className="flow-node-summary" title={data.summary}>
          {data.summary}
        </div>
        <NodeRegionPreview regions={data.regions ?? []} />
        {data.inspectionMode === 'execution' && <NodeFooter data={data} />}
        {!terminal &&
          (data.nodeType === 'condition' ? (
            <>
              <Handle type="source" id="true" position={Position.Right} style={{ top: '30%' }} />
              <Handle type="source" id="false" position={Position.Right} style={{ top: '75%' }} />
            </>
          ) : (
            <Handle type="source" id="out" position={Position.Right} />
          ))}
      </div>
    </>
  )
}

function NodeRegionPreview({ regions }: { regions: RegionPreview[] }) {
  if (!regions.length) return null
  return (
    <div className="flow-node-regions">
      {regions.map((region) => (
        <div key={region.id}>
          <strong>
            {region.label} · {region.steps.length} 步
          </strong>
          <small>{region.steps.join(' → ') || '尚未配置步骤'}</small>
        </div>
      ))}
    </div>
  )
}

function NodeFooter({ data }: { data: NodeData }) {
  return (
    <footer className="flow-node-footer">
      <span className="flow-node-status">
        {statusLabel[data.status] ?? data.status}
        {data.runtimeLabel && <small>{data.runtimeLabel}</small>}
      </span>
    </footer>
  )
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
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} label={label} />
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
