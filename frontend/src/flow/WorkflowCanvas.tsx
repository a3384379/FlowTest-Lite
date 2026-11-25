import {
  ApiOutlined, BranchesOutlined, CheckCircleOutlined, ClockCircleOutlined, ExportOutlined, FlagOutlined,
  PlayCircleOutlined, PlusOutlined,
} from '@ant-design/icons'
import {
  Background, BaseEdge, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow, getBezierPath,
  type Connection, type Edge, type EdgeProps, type Node, type NodeProps, type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Alert, Button, Drawer, Empty, Select, Space, Typography } from 'antd'
import { useRef, useState, type ReactNode } from 'react'
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
import { nodePresentation, type RegionPreview } from './editor/node-presentation'
import { useWorkflowEditor } from './editor/use-workflow-editor'
import { useDraftSession } from '../features/drafts/draft-session'
import { useNodeSelectionGuard } from './editor/use-node-selection-guard'
import { addApiNode, addTypedNode, autoLayoutWorkflow, insertNodeOnEdge, pasteNode, type PaletteNodeType } from './workflow-graph'
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
const labels: Record<WorkflowNode['type'], string> = {
  api: '接口', start: '开始', end: '结束', extract: '提取变量', assert: '断言',
  condition: '条件分支', delay: '等待', capability: '控制块',
}
const nodeIcons: Partial<Record<WorkflowNode['type'], ReactNode>> = {
  start: <PlayCircleOutlined />, end: <FlagOutlined />, extract: <ExportOutlined />,
  assert: <CheckCircleOutlined />, condition: <BranchesOutlined />, delay: <ClockCircleOutlined />,
}
const controls: ControlBlockKind[] = ['repeat', 'foreach', 'while', 'do_while', 'until', 'if', 'switch', 'parallel', 'try', 'group', 'fail']
const palette: PaletteNodeType[] = ['extract', 'assert', 'condition', 'delay', 'end']

type Props = {
  definition: WorkflowDefinition
  workflowId: string
  apis: ApiDefinition[]
  artifacts: Artifact[]
  environment?: string
  run?: FlowRun
  onChange: (definition: WorkflowDefinition) => void
}

export default function WorkflowCanvas({ definition, workflowId, apis, artifacts, environment, run, onChange }: Props) {
  const editor = useWorkflowEditor(definition, true, onChange)
  const current = editor.definition
  const [apiId, setApiId] = useState<string>()
  const [kind, setKind] = useState<PaletteNodeType | `control.${ControlBlockKind}`>('delay')
  const [inspection, setInspection] = useState<'config' | 'result'>('config')
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const scope = `workflow:${workflowId}:`
  const guard = useNodeSelectionGuard(useDraftSession(), scope, true)
  const canvas = useRef<ReactFlowInstance<CanvasNode, CanvasEdge> | null>(null)
  const selectedNode = current.nodes.find((node) => editor.selection?.kind === 'node' && editor.selection.id === node.id)
  const selectedEdge = current.edges.find((edge) => editor.selection?.kind === 'edge' && editor.selection.id === edge.id)
  const runNodes = new Map(run?.nodes.map((item) => [item.node_id, item]))
  const diagnostics = analyzeGraph(current)
  const activeApi = apis.find((api) => api.id === apiId) ?? apis[0]

  function inspect(kind: 'node' | 'edge', id: string, mode: 'config' | 'result' = 'config') {
    mutate(() => {
      editor.click(kind, id)
      setInspection(mode)
      setInspectorOpen(true)
    })
  }
  function add(type: 'api' | PaletteNodeType | `control.${ControlBlockKind}`) {
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
    const terminal = base.nodes.filter((node) => node.type === 'end')
    const incoming = terminal.length === 1 ? base.edges.filter((edge) => edge.target === terminal[0].id) : []
    const insertEdge = selectedEdge ?? (incoming.length === 1 && incoming[0].condition === null ? incoming[0] : undefined)
    if (insertEdge && type !== 'condition' && type !== 'end') {
      next = insertNodeOnEdge(next, newNode.id, insertEdge.id) ?? next
    }
    editor.commit(next, { kind: 'node', id: newNode.id })
    setInspection('config')
    setInspectorOpen(false)
    requestAnimationFrame(() => void canvas.current?.fitView({ padding: 0.2, duration: 160 }))
  }
  function mutate(action: () => void) { void guard.request().then((proceed) => { if (proceed) action() }) }
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
    const result = runNodes.get(node.id)
    const view = nodePresentation(node, current, apis)
    return {
      id: node.id, type: 'workflowNode',
      position: editor.positions.get(node.id) ?? node.position,
      selected: selectedNode?.id === node.id,
      data: {
        label: node.name, nodeType: type, typeLabel: controlCapabilityLabel(node.capability_id) ?? labels[type],
        status: result?.status ?? 'pending', runtimeLabel: result?.attempts ? `${result.attempts} 次` : '',
        ...view,
        inspectionMode: 'configuration',
        canCopy: type !== 'start' && type !== 'end',
        canDelete: type !== 'start' && (type !== 'end' || current.nodes.filter((item) => item.type === 'end').length > 1),
        onConfigure: () => inspect('node', node.id),
        onCopy: () => mutate(() => copy(node)),
        onDelete: () => mutate(() => { editor.click('node', node.id); editor.deleteSelection(); setInspectorOpen(false) }),
      },
    }
  })
  const edges: CanvasEdge[] = current.edges.map((edge) => ({
    id: edge.id, source: edge.source, target: edge.target, type: 'workflowEdge',
    sourceHandle: edge.condition ?? 'out',
    selected: selectedEdge?.id === edge.id,
    markerEnd: { type: MarkerType.ArrowClosed },
    label: edge.condition === 'true' ? '真' : edge.condition === 'false' ? '假' : undefined,
    data: {
      branch: edge.condition, editable: true,
      onConfigure: () => inspect('edge', edge.id),
      onDelete: () => mutate(() => { editor.click('edge', edge.id); editor.deleteSelection(); setInspectorOpen(false) }),
    },
  }))
  const selectedExecution = selectedNode && runNodes.get(selectedNode.id)

  return (
    <div className="workflow-editor">
      {guard.dialog}
      <div className="canvas-toolbar">
        <Space wrap>
          <Select
            aria-label="要添加的接口" value={activeApi?.id} onChange={setApiId}
            placeholder="选择接口" showSearch optionFilterProp="label" style={{ minWidth: 160, maxWidth: 260 }}
            options={apis.map((api) => ({ value: api.id, label: api.name }))}
          />
          <Button icon={<ApiOutlined />} disabled={!activeApi} onClick={() => mutate(() => add('api'))}>添加接口</Button>
          <Select
            aria-label="要添加的节点类型" value={kind} onChange={setKind} style={{ minWidth: 140 }}
            options={[
              ...palette.map((value) => ({ value, label: labels[value] })),
              ...controls.map((value) => ({ value: `control.${value}`, label: controlCapabilityLabel(`flow.control.${value}`) })),
            ]}
          />
          <Button icon={<PlusOutlined />} onClick={() => mutate(() => add(kind))}>添加节点</Button>
        </Space>
        <Space wrap>
          <Button disabled={!editor.past.length} onClick={() => mutate(editor.undo)}>撤销</Button>
          <Button disabled={!editor.future.length} onClick={() => mutate(editor.redo)}>重做</Button>
          <Button onClick={() => mutate(() => {
            editor.commit(autoLayoutWorkflow(editor.latest.current.definition))
            requestAnimationFrame(() => void canvas.current?.fitView({ padding: 0.2, duration: 160 }))
          })}>整理画布</Button>
          <WorkflowSettingsEditor
            definition={current} editable historical={false} beforeOpen={() => Promise.resolve(true)}
            onChange={(next) => editor.commit(next)}
          />
        </Space>
      </div>
      {editor.message && <Alert type="info" title={editor.message} closable onClose={() => editor.notify(null)} />}
      <div className="workflow-canvas lite-canvas" aria-label="流程画布">
        <ReactFlow<CanvasNode, CanvasEdge>
          nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
          fitView fitViewOptions={{ padding: 0.2 }} onInit={(instance) => { canvas.current = instance }}
          minZoom={0.15} maxZoom={1.7} deleteKeyCode={null}
          onConnect={(value) => editor.accept(connectGraphNodes(editor.latest.current.definition, connection(value)))}
          onReconnect={(edge, value) => editor.accept(reconnectGraphEdge(editor.latest.current.definition, edge.id, connection(value)))}
          onNodeClick={(_, node) => inspect('node', node.id, runNodes.has(node.id) ? 'result' : 'config')}
          onEdgeClick={(_, edge) => inspect('edge', edge.id)}
          onPaneClick={() => mutate(() => { editor.select(null); setInspectorOpen(false) })}
          onNodeDragStart={editor.beginDrag}
          onNodesChange={(changes) => {
            for (const change of changes) {
              if (change.type === 'position' && change.position)
                editor.positionsChanged([{ id: change.id, position: change.position }], change.dragging)
            }
          }}
        >
          <Background gap={22} />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>
      <div className="canvas-footer">
        <Typography.Text type="secondary">
          点选节点或连线编辑。拖动端口连接，条件节点上方为真、下方为假。
        </Typography.Text>
        {diagnostics.length > 0 && <Typography.Text type="warning">{diagnostics[0].message}</Typography.Text>}
      </div>
      <Drawer
        title={selectedNode?.name ?? '连线配置'} size={480} open={inspectorOpen}
        onClose={() => mutate(() => setInspectorOpen(false))} destroyOnHidden
        extra={selectedExecution && <Button onClick={() => mutate(() => setInspection(inspection === 'result' ? 'config' : 'result'))}>
          {inspection === 'result' ? '节点配置' : '运行结果'}
        </Button>}
      >
        {selectedNode ? (
          selectedExecution && inspection === 'result' ? <NodeResultView item={selectedExecution} /> : (
            <WorkflowNodeEditSession
              key={selectedNode.id} scope={scope} node={selectedNode} definition={current} editable
              onChange={(next) => editor.commit(next)}
            >
              {(node, update) => (
                <NodeInspector
                  node={node} definition={current} apis={apis} artifacts={artifacts} environment={environment} editable
                  onUpdate={(next) => update({
                    ...current, nodes: current.nodes.map((item) => item.id === next.id ? next : item),
                  }, 'node')}
                  onRegionUpdate={(next) => update({
                    ...current, regions: current.regions?.map((item) => item.id === next.id ? next : item),
                  }, 'regions')}
                  onStructureChange={(next) => update(next, 'structure')}
                />
              )}
            </WorkflowNodeEditSession>
          )
        ) : selectedEdge ? (
          <WorkflowEdgeInspector
            edge={selectedEdge} definition={current} editable
            onUpdate={(edge) => editor.commit({ ...current, edges: current.edges.map((item) => item.id === edge.id ? edge : item) })}
            onDelete={() => { editor.deleteSelection(); setInspectorOpen(false) }}
            onSwap={() => editor.accept(swapBranches(current, selectedEdge.source))}
          />
        ) : <Empty description="选择节点或连线" />}
      </Drawer>
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
        <NodeFooter data={data} />
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
