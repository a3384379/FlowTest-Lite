import { Link } from 'react-router-dom'
import { ApiOutlined } from '@ant-design/icons'
import { HttpMethodBadge } from '../features/api-console/ApiDirectory'
import { Alert, Checkbox, Form, Input, InputNumber, Select, Space, Typography } from 'antd'
import { editorNode, restoreEditedNode, adjacency, reachable } from './editor/graph-analysis'
import type { ApiDefinition, Artifact, WorkflowDefinition, WorkflowNode, WorkflowRegion } from '../lib/api'
import WorkflowApiRequestEditor from './WorkflowApiRequestEditor'
import WorkflowControlFields, { type RegionNodeEditorProps } from './WorkflowControlFields'
import WorkflowJsonInput from './WorkflowJsonInput'

type Props = {
  node: WorkflowNode
  definition: WorkflowDefinition
  apis: ApiDefinition[]
  artifacts: Artifact[]
  environment?: string
  editable: boolean
  onUpdate: (node: WorkflowNode) => void
  onStructureChange: (definition: WorkflowDefinition) => void
  onRegionUpdate: (region: WorkflowRegion) => void
}

const operators = [
  'equals', 'not_equals', 'contains', 'exists', 'less_than', 'less_than_or_equal',
  'greater_than', 'greater_than_or_equal', 'matches',
]

export default function NodeInspector(props: Props) {
  const { node: original, definition, apis, editable, onUpdate } = props
  const node = editorNode(original)
  const config = node.config
  function change(values: Record<string, unknown>) {
    onUpdate(restoreEditedNode(original, { ...node, config: { ...config, ...values } }))
  }
  function regionNode(region: RegionNodeEditorProps) {
    return (
      <NodeInspector
        {...props}
        node={region.node}
        onUpdate={region.onUpdate}
        onRegionUpdate={region.onRegionUpdate}
        onStructureChange={region.onStructureChange}
        definition={definition}
      />
    )
  }
  const type = node.type
  const referencedApi = apis.find((api) => api.id === config.api_definition_id)
  const allowedSources = sourceNodes(definition, node)
  return (
    <Form layout="vertical" component="div" disabled={!editable}>
      <Form.Item label="节点名称">
        <Input aria-label="节点名称" value={node.name} onChange={(event) => onUpdate({ ...original, name: event.target.value })} />
      </Form.Item>
      {type === 'api' && (
        <>
          <Form.Item label="引用接口">
            <Select
              aria-label="引用接口" showSearch optionFilterProp="label" placeholder="选择已保存的接口"
              value={typeof config.api_definition_id === 'string' && config.api_definition_id ? config.api_definition_id : undefined}
              options={apis.map((api) => ({ value: api.id, label: api.name }))}
              onChange={(api_definition_id) => change({ api_definition_id, api_version: undefined, request_overrides: {} })}
            />
          </Form.Item>
          {referencedApi && (
            <div className="inspector-api-reference">
              <HttpMethodBadge method={referencedApi.method} />
              <code>{referencedApi.path}</code>
              <Link to={`/apis?id=${referencedApi.id}`} title="在接口工作台打开" aria-label="打开引用接口"><ApiOutlined /></Link>
            </div>
          )}
          <WorkflowApiRequestEditor node={node} artifacts={props.artifacts} environmentId={props.environment} editable={editable}
            onUpdate={(updated) => onUpdate(restoreEditedNode(original, updated))} />
          <Form.Item label="预期 HTTP 状态码">
            <Select
              aria-label="预期 HTTP 状态码" mode="tags" placeholder="留空按 HTTP 100–399 判断"
              value={Array.isArray(config.expected_statuses) ? config.expected_statuses.map(String) : []}
              onChange={(values: string[]) => change({ expected_statuses: values.length ? values.map(Number) : null })}
            />
          </Form.Item>
          <Space wrap>
            <Form.Item label="超时（秒）">
              <InputNumber min={1} max={300} placeholder="跟随流程" value={numberValue(config.timeout_seconds)} onChange={(timeout_seconds) => change({ timeout_seconds })} />
            </Form.Item>
            <Form.Item label="重试次数">
              <InputNumber min={0} max={3} value={numberValue(config.max_retries) ?? 0} onChange={(max_retries) => change({ max_retries: max_retries ?? 0 })} />
            </Form.Item>
          </Space>
          <details>
            <summary>轮询及重试设置</summary>
            <JsonField field="api-options" value={{
              polling: config.polling ?? null, retry_delay_seconds: config.retry_delay_seconds ?? 0,
              retry_on: config.retry_on ?? ['network_error', '5xx'],
            }} editable={editable} onChange={(value) => { if (isRecord(value)) change(value) }} />
          </details>
        </>
      )}
      {['extract', 'assert', 'condition'].includes(type) && (
        <>
          <Form.Item label="数据源节点">
            <Select
              aria-label="数据源节点" placeholder="先连接上游节点"
              value={text(config.source_node_id) || undefined}
              options={allowedSources.map((item) => ({ value: item.id, label: item.name }))}
              onChange={(source_node_id) => change({ source_node_id })}
            />
          </Form.Item>
          <Form.Item label="JMESPath 表达式">
            <Input aria-label="JMESPath 表达式" placeholder="body.data.id" value={text(config.expression)}
              onChange={(event) => change({ expression: event.target.value })} />
          </Form.Item>
        </>
      )}
      {type === 'extract' && (
        <>
          <Form.Item label="保存为变量">
            <Input aria-label="保存为变量" value={text(config.variable)} onChange={(event) => change({ variable: event.target.value })} />
          </Form.Item>
          <Checkbox checked={config.required !== false} onChange={(event) => change({ required: event.target.checked })}>缺少值时报错</Checkbox>
        </>
      )}
      {(type === 'assert' || type === 'condition') && (
        <>
          {type === 'assert' && (
            <Form.Item label="断言类型">
              <Select value={config.assertion_type ?? 'comparison'} options={[
                { value: 'comparison', label: '比较' }, { value: 'json_schema', label: 'JSON Schema' },
              ]} onChange={(assertion_type) => change({
                assertion_type, expected_source_node_id: null, expected_expression: null,
              })} />
            </Form.Item>
          )}
          {config.assertion_type !== 'json_schema' && (
            <Form.Item label="比较运算">
              <Select aria-label="比较运算" value={config.operator ?? 'equals'} options={operators.map((value) => ({ value }))}
                onChange={(operator) => change({ operator })} />
            </Form.Item>
          )}
          {type === 'assert' && config.assertion_type !== 'json_schema' && (
            <>
              <Form.Item label="动态预期值来源（可选）">
                <Select allowClear value={config.expected_source_node_id ?? undefined}
                  options={allowedSources.map((item) => ({ value: item.id, label: item.name }))}
                  onChange={(expected_source_node_id) => change({
                    expected_source_node_id: expected_source_node_id ?? null,
                    expected_expression: expected_source_node_id ? 'body' : null,
                  })} />
              </Form.Item>
              {Boolean(config.expected_source_node_id) && (
                <Form.Item label="预期值 JMESPath">
                  <Input value={text(config.expected_expression)} onChange={(event) => change({ expected_expression: event.target.value })} />
                </Form.Item>
              )}
            </>
          )}
          {!config.expected_source_node_id && (
            <Form.Item label="预期值">
              <JsonField field="expected" value={config.expected ?? null} editable={editable} onChange={(expected) => change({ expected })} />
            </Form.Item>
          )}
        </>
      )}
      {type === 'delay' && (
        <Form.Item label="等待秒数">
          <InputNumber aria-label="等待秒数" min={0} max={300} step={0.1} value={numberValue(config.seconds) ?? 0}
            onChange={(seconds) => change({ seconds: seconds ?? 0 })} />
        </Form.Item>
      )}
      {type === 'start' && (
        <Form.Item label="启动时生成变量">
          <JsonField field="synthetic" value={config.synthetic_variables ?? {}} editable={editable}
            onChange={(synthetic_variables) => { if (isRecord(synthetic_variables)) change({ synthetic_variables }) }} />
          <Typography.Text type="secondary">可用生成器 uuid、unique_string、positive_integer。</Typography.Text>
        </Form.Item>
      )}
      {type === 'capability' && (
        original.capability_id?.startsWith('flow.control.') ? (
          <WorkflowControlFields
            node={original} definition={definition}
            regions={(definition.regions ?? []).filter((region) => region.owner_node_id === original.id)}
            apis={apis} editable={editable} onUpdate={onUpdate}
            onRegionUpdate={props.onRegionUpdate} onStructureChange={props.onStructureChange}
            renderRegionNode={regionNode}
          />
        ) : <Alert type="error" title={`不支持的节点 ${original.capability_id ?? original.type}`} />
      )}
    </Form>
  )
}

function JsonField({ field, value, editable, onChange }: {
  field: string; value: unknown; editable: boolean; onChange: (value: unknown) => void
}) {
  return <WorkflowJsonInput fieldKey={field} value={value} editable={editable} onChange={onChange} />
}

function sourceNodes(definition: WorkflowDefinition, node: WorkflowNode) {
  const region = definition.regions?.find((item) => item.nodes.some((candidate) => candidate.id === node.id))
  const scope = region ? { ...definition, nodes: region.nodes, edges: region.edges } : definition
  const upstream = reachable([node.id], adjacency(scope, true))
  return scope.nodes.filter((item) => item.id !== node.id && upstream.has(item.id))
}

function text(value: unknown) { return typeof value === 'string' ? value : '' }
function numberValue(value: unknown) { return typeof value === 'number' ? value : null }
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
