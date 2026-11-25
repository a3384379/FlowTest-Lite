import { FolderOpenOutlined, MoreOutlined, PlayCircleOutlined, PlusOutlined, SaveOutlined } from '@ant-design/icons'
import { useState, useSyncExternalStore } from 'react'
import { Alert, App, Button, Drawer, Dropdown, Empty, Form, Input, Modal, Segmented, Select, Space } from 'antd'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import AssetTabs from '../components/AssetTabs'
import { Status } from '../components/RunEvidence'
import WorkflowCanvas from '../flow/WorkflowCanvas'
import { jsonEqual } from '../flow/editor/editor-types'
import { useDraftSession } from '../features/drafts/draft-session'
import {
  apiDefinition, apiErrorMessage, client, createAsset, deleteAsset, listAssets, updateAsset,
  type Artifact, type FlowRun, type Workflow, type WorkflowDefinition, type WorkflowInput,
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

export default function FlowsPage({ environment }: { environment?: string }) {
  const [params, setParams] = useSearchParams()
  const [filter, setFilter] = useState('')
  const [creating, setCreating] = useState(false)
  const [savingId, setSavingId] = useState<string>()
  const [startingId, setStartingId] = useState<string>()
  const [cancelling, setCancelling] = useState(false)
  const [inputsOpen, setInputsOpen] = useState(false)
  const [view, setView] = useState<'edit' | 'run'>('edit')
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [runInputsOpen, setRunInputsOpen] = useState(false)
  const [selectedRun, setSelectedRun] = useState<{ flowId: string; id: string }>()
  const drafts = useDraftSession()
  const [work, setWork] = useState<Record<string, Workflow>>(() => Object.fromEntries(drafts.workflows))
  const cache = useQueryClient()
  const { message, modal } = App.useApp()
  useSyncExternalStore(drafts.subscribe, drafts.snapshot)
  const workflowList = useQuery({ queryKey: ['workflows'], queryFn: () => listAssets('workflow') })
  const apiList = useQuery({ queryKey: ['apis'], queryFn: () => listAssets('api') })
  const files = useQuery({ queryKey: ['files'], queryFn: () => client.get<Artifact[]>('/files').then((res) => res.data) })
  const workflows = workflowList.data ?? []
  const id = params.get('id') ?? workflows[0]?.id
  const saved = workflows.find((item) => item.id === id) ?? workflows[0]
  const current = saved && (work[saved.id] ?? saved)
  const dirty = Boolean(current && work[current.id])
  const recentRuns = useQuery({
    queryKey: ['workflow-runs', saved?.id],
    queryFn: () => Promise.resolve([] as Array<{ id: string; startedAt: number }>),
    enabled: false,
  }).data ?? []
  const latestId = recentRuns[0]?.id
  const runId = selectedRun && selectedRun.flowId === saved?.id ? selectedRun.id : latestId
  const runDefinition = useQuery({
    queryKey: ['run-definition', runId],
    queryFn: () => Promise.resolve(undefined as WorkflowDefinition | undefined),
    enabled: false,
  }).data
  const nodeDirty = Boolean(current && drafts.dirtyNodeEditorKeys(`workflow:${current.id}:`).length)
  const run = useQuery({
    queryKey: ['run', runId],
    queryFn: () => client.get<FlowRun>(`/runs/${runId}`).then((res) => res.data),
    enabled: Boolean(runId),
    refetchInterval: ({ state }) => !state.error && (!state.data || state.data.status === 'running') ? 400 : false,
  })
  const active = Boolean(latestId && cache.getQueryData<FlowRun>(['run', latestId])?.status === 'running')

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
    setRunInputsOpen(false)
    setView('edit')
    setSelectedRun(undefined)
    setCatalogOpen(false)
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
  async function copy(workflow: Workflow) {
    setSavingId('copy')
    try {
      const duplicate = await createAsset('workflow', {
        name: `${workflow.name.slice(0, 190)} 副本`,
        definition: workflow.definition,
        inputs: workflow.inputs,
      })
      saveToCatalog(duplicate)
      select(duplicate.id)
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
      setSelectedRun(undefined)
      setView('edit')
      setParams({})
    } catch (error) { notify(error) }
  }
  async function start(workflow: Workflow, variables?: Record<string, unknown>) {
    setStartingId(workflow.id)
    try {
      const { data } = await client.post<FlowRun>(`/workflows/${workflow.id}/run`, {
        environment_id: environment ?? null, runtime_variables: variables,
      })
      cache.setQueryData(['run', data.id], data)
      cache.setQueryData(['run-definition', data.id], workflow.definition)
      cache.setQueryData<Array<{ id: string; startedAt: number }>>(
        ['workflow-runs', workflow.id], (known) => [{ id: data.id, startedAt: Date.now() }, ...(known ?? []).slice(0, 7)],
      )
      if (workflow.id === current?.id) {
        setRunInputsOpen(false)
        setSelectedRun(undefined)
        setView('run')
      }
    } catch (error) { notify(error) }
    finally { setStartingId(undefined) }
  }
  async function cancel() {
    setCancelling(true)
    try {
      await client.post(`/runs/${latestId}/cancel`)
      await cache.invalidateQueries({ queryKey: ['run', latestId] })
    } catch (error) { notify(error) }
    finally { setCancelling(false) }
  }

  return (
    <>
      <div className="page-bar">
        <h1>流程编排</h1>
        <Space wrap size={8}>
          <Button icon={<FolderOpenOutlined />} onClick={() => setCatalogOpen(true)}>流程列表</Button>
          <Button icon={<PlusOutlined />} type={current ? 'default' : 'primary'} onClick={() => setCreating(true)}>新建流程</Button>
        </Space>
      </div>
      <AssetTabs label="已打开流程" active={current?.id} onSelect={select}
        entries={workflows.map((item) => ({ id: item.id, name: item.name, dirty: Boolean(work[item.id]) }))} />
      {workflowList.error && <Alert type="error" title={apiErrorMessage(workflowList.error)} />}
      {apiList.error && <Alert type="error" title={apiErrorMessage(apiList.error)} />}
      {files.error && <Alert type="error" title={apiErrorMessage(files.error)} />}
      <div className="flow-workspace">
        {current ? (
          <>
            <header className="flow-workbench-header">
              <div className="flow-heading">
                <h2>{current.name}</h2>
                {(dirty || nodeDirty) && <span className="workbench-state" data-dirty>未保存</span>}
                {active && <Status status="running" />}
              </div>
              <div className="flow-workbench-actions">
                <Segmented aria-label="工作流视图模式" value={view} onChange={setView}
                  options={[{ value: 'edit', label: '编排' }, { value: 'run', label: '运行视图', disabled: !runId || nodeDirty }]} />
                <Space wrap size={8}>
                  {view === 'run' && recentRuns.length > 1 && <Select aria-label="会话执行记录" value={runId} disabled={active}
                    onChange={(id) => setSelectedRun(id === latestId ? undefined : { flowId: current.id, id })}
                    options={recentRuns.map((item, index) => ({
                      value: item.id,
                      label: `${index === 0 ? '最近执行' : '执行记录'} · ${new Date(item.startedAt).toLocaleTimeString()}`,
                    }))} />}
                  <Button icon={<SaveOutlined />} loading={savingId === current.id}
                    disabled={!dirty || nodeDirty} onClick={() => void save(current)}>保存流程</Button>
                  {active ? <Button danger loading={cancelling} onClick={() => void cancel()}>取消运行</Button> : (
                    <Button type="primary" icon={<PlayCircleOutlined />} disabled={dirty || nodeDirty}
                      loading={startingId === current.id} onClick={() => void start(current)}>运行流程</Button>
                  )}
                  <Dropdown trigger={['click']} menu={{ items: [
                    { key: 'inputs', label: '名称与流程输入' },
                    { key: 'run-inputs', label: '使用临时输入运行', disabled: active || dirty || nodeDirty },
                    { key: 'copy', label: '复制流程', disabled: Boolean(savingId) || dirty || nodeDirty },
                    { key: 'delete', label: '删除流程', danger: true, disabled: active },
                  ], onClick: ({ key }) => {
                    if (key === 'inputs') setInputsOpen(true)
                    if (key === 'run-inputs') setRunInputsOpen(true)
                    if (key === 'copy') void copy(current)
                    if (key === 'delete') modal.confirm({
                      title: '删除这个流程？', okText: '删除流程',
                      okButtonProps: { danger: true }, onOk: () => remove(current),
                    })
                  } }}>
                    <Button icon={<MoreOutlined />} aria-label="工作流更多操作" />
                  </Dropdown>
                </Space>
              </div>
            </header>
            {run.error && view === 'run' && <Alert type="error" title={apiErrorMessage(run.error)} />}
            <div className={savingId === current.id ? 'flow-canvas-frame flow-saving' : 'flow-canvas-frame'}>
              <WorkflowCanvas
                key={current.id} workflowId={current.id} definition={current.definition}
                apis={(apiList.data ?? []).map(apiDefinition)} artifacts={files.data ?? []}
                environment={environment} run={run.data} view={view} runDefinition={runDefinition}
                onChange={(definition) => change({ ...current, definition })} />
            </div>
          </>
        ) : <Empty className="workspace-empty" description={workflowList.isPending ? '正在读取流程' : '选择或新建一个流程'} />}
      </div>
      <Drawer title="流程列表" placement="left" size={330} open={catalogOpen} onClose={() => setCatalogOpen(false)}
        extra={<Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => setCreating(true)}>新建</Button>}>
        <Input.Search aria-label="搜索流程" allowClear placeholder="搜索名称" value={filter} onChange={(event) => setFilter(event.target.value)} />
        <div className="flow-catalog">
          {workflows.filter((item) => item.name.toLowerCase().includes(filter.trim().toLowerCase())).map((item) => (
            <button key={item.id} type="button" className="catalog-item" aria-current={current?.id === item.id} onClick={() => select(item.id)}>
              <strong>{item.name}</strong>
              <small>{work[item.id] ? '未保存' : `${item.definition.nodes.length} 个节点`}</small>
            </button>
          ))}
          {!workflows.some((item) => item.name.toLowerCase().includes(filter.trim().toLowerCase())) && <Empty description="暂无匹配流程" />}
        </div>
      </Drawer>
      {creating && <CreateFlowDialog onCreate={create} onClose={() => setCreating(false)} busy={savingId === 'new'} />}
      {current && runInputsOpen && <TemporaryInputs key={current.id} workflow={current} busy={startingId === current.id}
        onClose={() => setRunInputsOpen(false)} onRun={(values) => start(current, values)} />}
      {current && inputsOpen && <FlowInputs workflow={current} close={() => setInputsOpen(false)} onApply={(input) => {
        change({ ...current, ...input })
        setInputsOpen(false)
      }} />}
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

function TemporaryInputs({ workflow, busy, onClose, onRun }: {
  workflow: Workflow; busy: boolean; onClose: () => void
  onRun: (values: Record<string, unknown>) => Promise<void>
}) {
  const [text, setText] = useState(() => JSON.stringify(workflow.inputs, null, 2))
  const [error, setError] = useState('')
  function run() {
    try {
      const values: unknown = JSON.parse(text)
      if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('流程输入应为 JSON 对象')
      void onRun(values as Record<string, unknown>)
    } catch (cause) { setError(apiErrorMessage(cause)) }
  }
  return (
    <Modal open width={560} title="使用临时输入运行" confirmLoading={busy} okText="运行流程" onCancel={onClose} onOk={run}>
      <Form layout="vertical">
        <Form.Item label="本次输入（JSON）" extra="应用于本次运行，流程中的默认输入继续保留。">
          <Input.TextArea className="code-input" aria-label="本次流程输入" rows={7} value={text}
            onChange={(event) => { setText(event.target.value); setError('') }} />
        </Form.Item>
      </Form>
      {error && <Alert type="error" title={error} />}
    </Modal>
  )
}
