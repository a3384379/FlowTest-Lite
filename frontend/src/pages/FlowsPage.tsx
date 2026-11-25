import { useState } from 'react'
import { Alert, App, Button, Card, Drawer, Empty, Form, Input, Modal, Popconfirm, Space, Table, Typography } from 'antd'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import EnvironmentToolbar, { type EnvironmentSelection } from '../components/EnvironmentToolbar'
import { NodeResultView, Status } from '../components/RunEvidence'
import WorkflowCanvas from '../flow/WorkflowCanvas'
import { jsonEqual } from '../flow/editor/editor-types'
import { useDraftSession } from '../features/drafts/draft-session'
import {
  apiDefinition, apiErrorMessage, client, createAsset, deleteAsset, listAssets, updateAsset,
  type Artifact, type FlowRun, type NodeExecution, type Workflow, type WorkflowDefinition, type WorkflowInput,
} from '../lib/api'

const initialDefinition: WorkflowDefinition = {
  schema_version: '1.0', variables: {}, regions: [], runtime_inputs: [],
  settings: { concurrency: 4, fail_fast: true, default_timeout_seconds: 30 },
  nodes: [
    { id: 'start', name: '开始', type: 'start', position: { x: 100, y: 160 }, config: {} },
    { id: 'end', name: '结束', type: 'end', position: { x: 440, y: 160 }, config: {} },
  ],
  edges: [{ id: 'start-end', source: 'start', target: 'end', condition: null, mappings: [] }],
}

export default function FlowsPage(selection: EnvironmentSelection) {
  const [params, setParams] = useSearchParams()
  const [filter, setFilter] = useState('')
  const [creating, setCreating] = useState(false)
  const [savingId, setSavingId] = useState<string>()
  const [startingId, setStartingId] = useState<string>()
  const [cancelling, setCancelling] = useState(false)
  const [inputsOpen, setInputsOpen] = useState(false)
  const [resultsOpen, setResultsOpen] = useState(false)
  const drafts = useDraftSession()
  const [work, setWork] = useState<Record<string, Workflow>>(() => Object.fromEntries(drafts.workflows))
  const cache = useQueryClient()
  const { message } = App.useApp()
  const workflowList = useQuery({ queryKey: ['workflows'], queryFn: () => listAssets('workflow') })
  const apiList = useQuery({ queryKey: ['apis'], queryFn: () => listAssets('api') })
  const files = useQuery({ queryKey: ['files'], queryFn: () => client.get<Artifact[]>('/files').then((res) => res.data) })
  const workflows = workflowList.data ?? []
  const id = params.get('id') ?? workflows[0]?.id
  const saved = workflows.find((item) => item.id === id)
  const current = saved && (work[saved.id] ?? saved)
  const dirty = Boolean(current && work[current.id])
  const last = useQuery({
    queryKey: ['latest-run', id],
    queryFn: () => Promise.resolve(null as string | null),
    staleTime: Infinity,
    enabled: false,
  })
  const runId = last.data
  const run = useQuery({
    queryKey: ['run', runId],
    queryFn: () => client.get<FlowRun>(`/runs/${runId}`).then((res) => res.data),
    enabled: Boolean(runId),
    refetchInterval: ({ state }) => !state.error && (!state.data || state.data.status === 'running') ? 400 : false,
  })
  const active = run.data?.status === 'running'

  function notify(error: unknown) { message.error(apiErrorMessage(error)) }
  function saveToCatalog(workflow: Workflow) {
    cache.setQueryData<Workflow[]>(['workflows'], (list) => [
      workflow, ...(list ?? []).filter((item) => item.id !== workflow.id),
    ])
  }
  function clear(key: string) {
    drafts.workflows.delete(key)
    setWork((previous) => {
      const next = { ...previous }
      delete next[key]
      return next
    })
    drafts.markUnsafe(`flow:${key}`, false)
  }
  function change(value: Workflow) {
    if (saved && jsonEqual(value, saved)) clear(value.id)
    else {
      drafts.workflows.set(value.id, value)
      setWork((previous) => ({ ...previous, [value.id]: value }))
      drafts.markUnsafe(`flow:${value.id}`, true)
    }
  }
  function select(key: string) {
    setInputsOpen(false)
    setResultsOpen(false)
    setParams({ id: key })
  }
  async function create(name: string) {
    if (savingId) return
    setSavingId('new')
    try {
      const workflow = await createAsset('workflow', { name, inputs: {}, definition: initialDefinition })
      saveToCatalog(workflow)
      select(workflow.id)
      setCreating(false)
    } catch (error) { notify(error) }
    finally { setSavingId(undefined) }
  }
  async function save(workflow: Workflow) {
    if (savingId) return
    if (drafts.dirtyNodeEditorKeys(`workflow:${workflow.id}:`).length) {
      message.error('请先在节点配置中应用修改')
      return
    }
    const { id: key, revision, updated_at: _stamp, ...input } = workflow
    setSavingId(key)
    try {
      const saved = await updateAsset('workflow', key, revision, input)
      saveToCatalog(saved)
      clear(key)
      message.success('已保存流程')
    } catch (error) { notify(error) }
    finally { setSavingId(undefined) }
  }
  async function remove(workflow: Workflow) {
    try {
      await deleteAsset('workflow', workflow.id)
      cache.setQueryData<Workflow[]>(['workflows'], (list) => list?.filter((item) => item.id !== workflow.id))
      clear(workflow.id)
      drafts.dirtyNodeEditorKeys(`workflow:${workflow.id}:`).forEach((key) => drafts.clearNodeEditor(key))
      setParams({})
    } catch (error) { notify(error) }
  }
  async function start(workflow: Workflow) {
    setStartingId(workflow.id)
    try {
      const { data } = await client.post<FlowRun>(`/workflows/${workflow.id}/run`, {
        environment_id: selection.environment ?? null,
      })
      cache.setQueryData(['run', data.id], data)
      cache.setQueryData(['latest-run', workflow.id], data.id)
      if (workflow.id === current?.id) setResultsOpen(true)
    } catch (error) { notify(error) }
    finally { setStartingId(undefined) }
  }
  async function cancel() {
    setCancelling(true)
    try {
      await client.post(`/runs/${runId}/cancel`)
      await cache.invalidateQueries({ queryKey: ['run', runId] })
    } catch (error) { notify(error) }
    finally { setCancelling(false) }
  }

  return (
    <>
      <div className="page-bar">
        <h1>流程</h1>
        <Space wrap>
          <EnvironmentToolbar {...selection} />
          <Button type="primary" onClick={() => setCreating(true)}>新建流程</Button>
        </Space>
      </div>
      {workflowList.error && <Alert type="error" title={apiErrorMessage(workflowList.error)} />}
      {apiList.error && <Alert type="error" title={apiErrorMessage(apiList.error)} />}
      {files.error && <Alert type="error" title={apiErrorMessage(files.error)} />}
      <div className="flow-workspace">
        <Card title="流程列表" loading={workflowList.isPending}>
          <Space orientation="vertical" className="full-width">
            <Input.Search aria-label="搜索流程" allowClear placeholder="搜索名称" value={filter} onChange={(event) => setFilter(event.target.value)} />
            {workflows.filter((item) => item.name.toLowerCase().includes(filter.trim().toLowerCase())).map((item) => (
              <button key={item.id} type="button" className="catalog-item" aria-current={current?.id === item.id} onClick={() => select(item.id)}>
                <span>{item.name}</span>{work[item.id] && <small>未保存</small>}
              </button>
            ))}
            {!workflows.length && <Empty description="暂无流程" />}
          </Space>
        </Card>
        <Card
          title={current?.name ?? '流程画布'}
          extra={current && <Space wrap>
            {dirty && <Typography.Text type="warning">未保存</Typography.Text>}
            <Button onClick={() => setInputsOpen(true)}>名称与流程输入</Button>
            <Button type="primary" loading={savingId === current.id} disabled={!dirty} onClick={() => void save(current)}>保存流程</Button>
            <Button type="primary" disabled={dirty || active} loading={startingId === current.id} onClick={() => void start(current)}>运行流程</Button>
            {active && <Button danger loading={cancelling} onClick={() => void cancel()}>取消运行</Button>}
            {runId && <Button onClick={() => setResultsOpen(true)}>运行详情</Button>}
            <Popconfirm title="删除这个流程？" onConfirm={() => remove(current)}><Button danger disabled={active}>删除流程</Button></Popconfirm>
          </Space>}
        >
          {current ? (
            <div className={savingId === current.id ? 'flow-saving' : undefined}>
              <WorkflowCanvas
                key={current.id} workflowId={current.id} definition={current.definition}
                apis={(apiList.data ?? []).map(apiDefinition)} artifacts={files.data ?? []}
                environment={selection.environment} run={run.data}
                onChange={(definition) => change({ ...current, definition })}
              />
            </div>
          ) : <Empty description="选择或新建一个流程" />}
        </Card>
      </div>
      {creating && <CreateFlowDialog onCreate={create} onClose={() => setCreating(false)} busy={savingId === 'new'} />}
      {current && inputsOpen && <FlowInputs workflow={current} close={() => setInputsOpen(false)} onApply={(input) => {
        change({ ...current, ...input })
        setInputsOpen(false)
      }} />}
      <Drawer title="运行详情" size={720} open={resultsOpen} onClose={() => setResultsOpen(false)} destroyOnHidden
        extra={active && <Button danger loading={cancelling} onClick={() => void cancel()}>取消运行</Button>}>
        {run.error && <Alert type="error" title={apiErrorMessage(run.error)} />}
        {run.data && <RunDetails run={run.data} />}
      </Drawer>
    </>
  )
}

function CreateFlowDialog({ onCreate, onClose, busy }: { onCreate: (name: string) => Promise<void>; onClose: () => void; busy: boolean }) {
  const [form] = Form.useForm<{ name: string }>()
  return (
    <Modal open title="新建流程" onCancel={onClose} onOk={() => form.submit()} okText="创建" confirmLoading={busy}>
      <Form form={form} layout="vertical" onFinish={({ name }) => void onCreate(name.trim())}>
        <Form.Item name="name" label="流程名称" rules={[{ required: true, whitespace: true }]}><Input maxLength={200} /></Form.Item>
      </Form>
    </Modal>
  )
}

function FlowInputs({ workflow, close, onApply }: { workflow: Workflow; close: () => void; onApply: (input: WorkflowInput) => void }) {
  const [form] = Form.useForm<{ name: string; definitions: string; values: string }>()
  const [error, setError] = useState('')
  function apply(fields: { name: string; definitions: string; values: string }) {
    try {
      const runtime_inputs = JSON.parse(fields.definitions)
      const inputs = JSON.parse(fields.values)
      if (!Array.isArray(runtime_inputs)) throw new Error('输入声明应为 JSON 数组')
      if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) throw new Error('输入值应为 JSON 对象')
      onApply({ name: fields.name.trim(), inputs, definition: { ...workflow.definition, runtime_inputs } })
    } catch (cause) { setError(apiErrorMessage(cause)) }
  }
  return (
    <Modal open title="名称与流程输入" width={600} onCancel={close} onOk={() => form.submit()} okText="应用">
      {error && <Alert type="error" title={error} />}
      <Form form={form} layout="vertical" onFinish={apply} initialValues={{
        name: workflow.name,
        definitions: JSON.stringify(workflow.definition.runtime_inputs ?? [], null, 2),
        values: JSON.stringify(workflow.inputs, null, 2),
      }}>
        <Form.Item name="name" label="流程名称" rules={[{ required: true, whitespace: true }]}><Input maxLength={200} /></Form.Item>
        <Form.Item name="values" label="流程输入值（JSON）" extra="请求中使用 {{变量名}}。值随流程保存。">
          <Input.TextArea rows={5} className="code-input" />
        </Form.Item>
        <Form.Item name="definitions" label="输入声明（可选）" extra='示例 [{"name":"id","value_type":"integer","required":true}]'>
          <Input.TextArea rows={4} className="code-input" />
        </Form.Item>
      </Form>
    </Modal>
  )
}

function RunDetails({ run }: { run: FlowRun }) {
  const [focused, setFocused] = useState<string>()
  const ordered = run.nodes.toSorted((left, right) => {
    if (!left.started_at && right.started_at) return 1
    if (left.started_at && !right.started_at) return -1
    return (left.started_at ?? left.occurred_at).localeCompare(right.started_at ?? right.occurred_at)
  })
  const suggested = ordered.find((item) => item.status === 'failed') ?? ordered.find((item) => item.result?.observations.length)
  const current = run.nodes.find((item) => item.node_id === focused) ?? suggested
  return (
    <Space orientation="vertical" size="middle" className="full-width">
      <Status status={run.status} />
      {run.error && <Alert type="error" title={run.error} />}
      <Table<NodeExecution> rowKey="node_id" size="small" pagination={false} dataSource={ordered} columns={[
        { title: '执行步骤', render: (_, item) => <Button type="link" onClick={() => setFocused(item.node_id)}>{item.name}</Button> },
        { title: '状态', render: (_, item) => <Status status={item.status} /> },
        { title: '尝试', dataIndex: 'attempts' },
        { title: '原因', dataIndex: 'error_message' },
      ]} />
      {current && <Card title={current.name}><NodeResultView item={current} /></Card>}
    </Space>
  )
}
