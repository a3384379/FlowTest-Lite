import { effectiveConfig, resolveEffectiveNodeType } from './editor/graph-analysis'
import { copyControlRegions } from './editor/control-blocks'

import type { WorkflowDefinition, WorkflowNode } from '../lib/api'

export type PaletteNodeType = 'extract' | 'assert' | 'condition' | 'delay' | 'end'

export function workflowNodeSize(type: WorkflowNode['type']) {
  return type === 'start' || type === 'end'
    ? { width: 132, height: 52 }
    : { width: 228, height: 82 }
}

export function insertNodeOnEdge(
  definition: WorkflowDefinition,
  nodeId: string,
  edgeId: string,
): WorkflowDefinition | null {
  const edge = definition.edges.find((candidate) => candidate.id === edgeId)
  const added = definition.nodes.find((node) => node.id === nodeId)
  if (!edge || !added || edge.mappings.length > 0) return null
  const source = definition.nodes.find((node) => node.id === edge.source)
  const target = definition.nodes.find((node) => node.id === edge.target)
  if (!source || !target) return null
  let nextId = `${edge.id}-${nodeId}`
  while (definition.edges.some((candidate) => candidate.id === nextId)) nextId += '-copy'
  return autoLayoutWorkflow({
    ...definition,
    edges: [
      ...definition.edges.filter((candidate) => candidate.id !== edgeId),
      { ...edge, target: nodeId },
      { id: nextId, source: nodeId, target: edge.target, condition: null, mappings: [] },
    ],
  })
}

export function addApiNode(
  definition: WorkflowDefinition,
  apiId: string,
): WorkflowDefinition {
  const id = uniqueNodeId(definition, 'api')
  return {
    ...definition,
    nodes: [
      ...definition.nodes,
      {
        id,
        type: 'api',
        name: `接口请求 ${definition.nodes.filter((node) => node.type === 'api').length + 1}`,
        position: nextPosition(definition),
        config: {
          api_definition_id: apiId,
          request_overrides: {},
          max_retries: 0,
          retry_on: ['network_error', '5xx'],
        },
      },
    ],
  }
}

export function addTypedNode(
  definition: WorkflowDefinition,
  type: PaletteNodeType,
): WorkflowDefinition {
  const id = uniqueNodeId(definition, type)
  return {
    ...definition,
    nodes: [
      ...definition.nodes,
      {
        id,
        type,
        name: defaultNodeName(type),
        position: nextPosition(definition),
        config: defaultNodeConfig(definition, type),
      },
    ],
  }
}

function uniqueNodeId(definition: WorkflowDefinition, prefix: string): string {
  const existing = new Set(definition.nodes.map((node) => node.id))
  let index = existing.size + 1
  while (existing.has(`${prefix}-${index}`)) index += 1
  return `${prefix}-${index}`
}

function nextPosition(definition: WorkflowDefinition) {
  const rightmost = Math.max(0, ...definition.nodes.map((node) =>
    node.position.x + workflowNodeSize(resolveEffectiveNodeType(node)).width,
  ))
  return { x: rightmost + 64, y: 120 + (definition.nodes.length % 3) * 112 }
}

function defaultNodeName(type: PaletteNodeType): string {
  return {
    extract: '提取变量',
    assert: '断言校验',
    condition: '条件判断',
    delay: '等待',
      end: '结束',
  }[type]
}

function defaultNodeConfig(
  definition: WorkflowDefinition,
  type: PaletteNodeType,
): Record<string, unknown> {
  const sourceNodeId =
    definition.nodes.findLast(
      (node) =>
        !['start', 'end'].includes(resolveEffectiveNodeType(node)) && node.phase !== 'cleanup',
    )?.id ?? ''
  if (isSourceNodeType(type)) {
    const config = sourceNodeConfig(type, sourceNodeId)
    return type === 'extract' ? { ...config, variable: uniqueExtractVariable(definition) } : config
  }
  return type === 'delay' ? { seconds: 1 } : {}
}

function isSourceNodeType(type: PaletteNodeType): type is 'extract' | 'assert' | 'condition' {
  return type === 'extract' || type === 'assert' || type === 'condition'
}

function sourceNodeConfig(
  type: 'extract' | 'assert' | 'condition',
  sourceNodeId: string,
): Record<string, unknown> {
  if (type === 'extract') {
    return { source_node_id: sourceNodeId, expression: 'body', variable: 'extracted_value' }
  }
  if (type === 'assert') {
    return {
      source_node_id: sourceNodeId,
      expression: 'status_code',
      operator: 'equals',
      expected: 200,
    }
  }
  if (type === 'condition') {
    return {
      source_node_id: sourceNodeId,
      expression: 'body.enabled',
      operator: 'equals',
      expected: true,
    }
  }
  return {}
}

export function pasteNode(
  definition: WorkflowDefinition,
  copied: WorkflowNode,
): WorkflowDefinition {
  const id = uniqueNodeId(definition, `${copied.type}-copy`)
  const copiedRegions = copyControlRegions(definition, copied.id, id)
  return {
    ...definition,
    regions: [...(definition.regions ?? []), ...copiedRegions.regions],
    nodes: [
      ...definition.nodes,
      {
        ...structuredClone(copied),
        id,
        name: `${copied.name.slice(0, 197)} 副本`,
        position: { x: copied.position.x + 40, y: copied.position.y + 40 },
        config: structuredClone(copied.config),
        configuration:
          copiedRegions.configuration ??
          (copied.configuration ? structuredClone(copied.configuration) : undefined),
        bindings: copied.bindings ? structuredClone(copied.bindings) : undefined,
      },
    ],
  }
}

export function autoLayoutWorkflow(definition: WorkflowDefinition): WorkflowDefinition {
  const levels = workflowLevels(definition)
  const columnWidths = new Map<number, number>()
  for (const node of definition.nodes) {
    const level = mapValue(levels, node.id)
    const { width } = workflowNodeSize(resolveEffectiveNodeType(node))
    columnWidths.set(level, Math.max(columnWidths.get(level) ?? 0, width))
  }
  const columns = new Map<number, number>()
  let x = 0
  for (const [level, width] of [...columnWidths].sort(([a], [b]) => a - b)) {
    columns.set(level, x)
    x += width + 64
  }
  const main = layoutPhase(
    definition.nodes.filter((node) => node.phase !== 'cleanup'),
    levels, columns,
    0,
  )
  const cleanupOffset = Math.max(0, ...[...main.values()].map((position) => position.y)) + 156
  const cleanup = layoutPhase(
    definition.nodes.filter((node) => node.phase === 'cleanup'),
    levels, columns,
    cleanupOffset,
  )
  const positions = new Map([...main, ...cleanup])
  return {
    ...definition,
    nodes: definition.nodes.map((node) => ({
      ...node,
      position: positions.get(node.id) ?? node.position,
    })),
  }
}
function layoutPhase(nodes: WorkflowNode[], levels: Map<string, number>, columns: Map<number, number>, offset: number) {
  const rows = new Map<number, number>()
  return new Map(
    nodes.map((node) => {
      const level = levels.get(node.id) ?? 0
      const row = rows.get(level) ?? 0
      const { height } = workflowNodeSize(resolveEffectiveNodeType(node))
      rows.set(level, row + height + 38)
      return [node.id, { x: columns.get(level) ?? 0, y: row + offset }]
    }),
  )
}
function uniqueExtractVariable(definition: WorkflowDefinition): string {
  const names = new Set(definition.nodes.map((node) => effectiveConfig(node).variable))
  let name = 'extracted_value'
  let index = 2
  while (names.has(name)) name = `extracted_value_${index++}`
  return name
}

function workflowLevels(definition: WorkflowDefinition): Map<string, number> {
  const { incoming, outgoing } = workflowAdjacency(definition)
  const levels = new Map<string, number>()
  const pending = definition.nodes
    .filter((node) => incoming.get(node.id) === 0)
    .map((node) => node.id)
  while (pending.length) {
    const current = pending.shift() as string
    assignTargetLevels(current, levels, incoming, outgoing, pending)
  }
  return levels
}

function workflowAdjacency(definition: WorkflowDefinition) {
  const incoming = new Map(definition.nodes.map((node) => [node.id, 0]))
  const outgoing = new Map(definition.nodes.map((node) => [node.id, [] as string[]]))
  for (const edge of definition.edges) {
    incoming.set(edge.target, mapValue(incoming, edge.target) + 1)
    outgoing.get(edge.source)?.push(edge.target)
  }
  return { incoming, outgoing }
}

function assignTargetLevels(
  current: string,
  levels: Map<string, number>,
  incoming: Map<string, number>,
  outgoing: Map<string, string[]>,
  pending: string[],
) {
  const currentLevel = mapValue(levels, current)
  for (const target of outgoing.get(current) ?? []) {
    levels.set(target, Math.max(mapValue(levels, target), currentLevel + 1))
    const remaining = mapValue(incoming, target) - 1
    incoming.set(target, remaining)
    if (remaining === 0) pending.push(target)
  }
}

function mapValue(values: Map<string, number>, key: string): number {
  return values.get(key) ?? 0
}
