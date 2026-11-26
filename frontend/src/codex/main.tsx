import { useState, type FormEvent, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiAsset, FlowRun, InterfaceRun, NodeExecution, Project, RequestSnapshot, Workflow } from '../lib/api'
import { call, host } from './bridge'
import { Checks, JsonPanel, NodeEvidence, RequestEvidence, ResponseEvidence, Status } from './evidence'
import styles from './workbench.css?raw'

type Page = 'apis' | 'flows'
type Asset = { id: string; name: string; revision: number }
type CatalogItem = Asset & { method?: string; path?: string; group?: string; node_count?: number }
type Catalog = { items: CatalogItem[]; total: number; next_offset: number | null }
const pageSize = 50

function ErrorMessage({ error }: { error: Error | null }) {
  return error && <p className="error" role="alert">{error.message}</p>
}

function Workbench({ projectId, picker, page, onPage, runs, onRun }: {
  projectId: string; picker: ReactNode; page: Page; onPage: (page: Page) => void
  runs: Record<string, string>; onRun: (key: string, id: string) => void
}) {
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [selections, setSelections] = useState<Partial<Record<Page, string>>>({})
  const [environment, setEnvironment] = useState('')
  const cache = useQueryClient()
  const catalog = useQuery({
    queryKey: ['catalog', projectId, page, query, offset],
    queryFn: () => call<Catalog>(page === 'apis' ? 'api_list' : 'workflow_list', {
      query, offset, limit: pageSize, project_id: projectId,
    }),
  })
  const environments = useQuery({
    queryKey: ['environments', projectId],
    queryFn: () => call<{ items: Asset[] }>('environment_list', { project_id: projectId }),
  })
  const selected = catalog.data?.items.find((item) => item.id === selections[page]) ?? catalog.data?.items[0]
  const editor = useMutation({
    mutationFn: ({ page, id }: { page: Page; id?: string }) => call<{ url: string; opened: boolean }>(
      'workbench_open', { page, project_id: projectId, ...(id ? { asset_id: id } : {}) },
    ),
  })

  function navigate(target: Page) {
    if (page === target) return
    onPage(target)
    setInput('')
    setQuery('')
    setOffset(0)
    editor.reset()
  }

  function search(event: FormEvent) {
    event.preventDefault()
    setQuery(input.trim())
    setOffset(0)
  }

  return <>
    <header className="top">
      <div className="brand"><span aria-hidden="true" className="brand-mark">FT</span><h1>FlowTest<span> Lite</span></h1>{picker}</div>
      <nav aria-label="工作台">
        <button type="button" aria-current={page === 'apis' ? 'page' : undefined} onClick={() => navigate('apis')}>接口</button>
        <button type="button" aria-current={page === 'flows' ? 'page' : undefined} onClick={() => navigate('flows')}>流程</button>
      </nav>
      <div className="top-actions">
        <select aria-label="运行环境" value={environment} onChange={(event) => setEnvironment(event.target.value)}>
          <option value="">默认环境</option>
          {environments.data?.items.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <button type="button" className="secondary" onClick={() => editor.mutate({ page, id: selected?.id })}
          disabled={editor.isPending}>在浏览器打开编辑器 ↗</button>
      </div>
    </header>
    <ErrorMessage error={editor.error ?? environments.error} />
    {editor.data && !editor.data.opened && <div className="manual">
      <label>在浏览器输入此地址 <input type="url" readOnly value={editor.data.url} onFocus={(event) => event.target.select()} /></label>
    </div>}
    <div className="workspace">
      <aside className="catalog" aria-label={page === 'apis' ? '接口列表' : '流程列表'}>
        <div className="spread"><h2>{page === 'apis' ? '接口列表' : '流程列表'}</h2>
          <button type="button" onClick={() => {
            void cache.invalidateQueries({ queryKey: ['catalog'] })
            void cache.invalidateQueries({ queryKey: ['asset'] })
            void cache.invalidateQueries({ queryKey: ['environments'] })
          }}>刷新</button>
        </div>
        <form className="search" onSubmit={search}>
          <input type="search" aria-label={page === 'apis' ? '搜索接口' : '搜索流程'} placeholder="搜索名称"
            value={input} onChange={(event) => setInput(event.target.value)} />
          <button type="submit">搜索</button>
        </form>
        {catalog.isPending && <p className="muted" role="status">正在读取本机数据…</p>}
        <ErrorMessage error={catalog.error} />
        {catalog.data && <>
          <p className="catalog-count">共 {catalog.data.total} 项</p>
          {catalog.data.items.length === 0 && <p className="muted">{query ? '没有匹配的条目。' : '暂无已保存条目。'}</p>}
          <ul>
            {catalog.data.items.map((item) => <li key={item.id}>
              <button type="button" className="catalog-row" aria-current={item.id === selected?.id}
                onClick={() => {
                  setSelections((previous) => ({ ...previous, [page]: item.id }))
                  editor.reset()
                }}>
                <span className="item-title">{item.method && <span className="method">{item.method}</span>}<strong>{item.name}</strong></span>
                <small>{item.path ? [item.group, item.path].filter(Boolean).join(' · ') : `${item.node_count} 个主画布节点`}</small>
              </button>
            </li>)}
          </ul>
          {(offset > 0 || catalog.data.next_offset != null) && <div className="spread pagination">
            <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - pageSize))}>上一页</button>
            <button type="button" disabled={catalog.data.next_offset == null}
              onClick={() => setOffset(catalog.data?.next_offset ?? offset)}>下一页</button>
          </div>}
        </>}
      </aside>
      <main className="detail" aria-label="条目详情">
        {selected
          ? page === 'apis'
            ? <ApiDetail key={selected.id} projectId={projectId} item={selected} environment={environment} />
            : <FlowDetail key={selected.id} projectId={projectId} item={selected} environment={environment}
                runId={runs[`${projectId}:${selected.id}`]} onRun={(id) => onRun(`${projectId}:${selected.id}`, id)} />
          : !catalog.isPending && !catalog.error && <p className="muted empty">选择条目后查看详情。</p>}
      </main>
    </div>
  </>
}

function ProjectWorkbench() {
  const [project, setProject] = useState<string>()
  const [page, setPage] = useState<Page>('apis')
  const [runs, setRuns] = useState<Record<string, string>>({})
  const [editor, setEditor] = useState<{ id?: string; name: string }>()
  const cache = useQueryClient()
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => call<{ items: Project[]; default_project_id: string }>('project_list'),
  })
  const current = projects.data?.items.find((item) => item.id === (project ?? projects.data?.default_project_id))
  const save = useMutation({
    mutationFn: ({ id, name }: { id?: string; name: string }) => call<Project>(id ? 'project_rename' : 'project_create',
      { name: name.trim(), ...(id ? { project_id: id } : {}) }),
    onSuccess: (saved, input) => {
      cache.setQueryData<typeof projects.data>(['projects'], (previous) => previous && {
        ...previous,
        items: input.id ? previous.items.map((item) => item.id === saved.id ? saved : item) : [...previous.items, saved],
      })
      setProject(saved.id)
      setEditor(undefined)
    },
  })

  function edit(next: { id?: string; name: string }) {
    save.reset()
    setEditor(next)
  }

  const picker = <div className="project-picker">
    <select aria-label="当前项目" value={current?.id ?? ''} disabled={save.isPending}
      onChange={(event) => { setProject(event.target.value); setEditor(undefined) }}>
      {projects.data?.items.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select>
    <button type="button" disabled={save.isPending} onClick={() => edit({ name: '' })}>新建项目</button>
    <button type="button" disabled={save.isPending || !current}
      onClick={() => current && edit(current)}>重命名项目</button>
  </div>
  const projectForm = editor && <form className="project-form" onSubmit={(event) => {
    event.preventDefault()
    if (editor.name.trim() && !save.isPending) save.mutate(editor)
  }}>
    <label>项目名称 <input maxLength={80} required autoFocus value={editor.name}
      onChange={(event) => setEditor({ ...editor, name: event.target.value })} /></label>
    <button type="submit" className="primary" disabled={save.isPending || !editor.name.trim()}>保存项目</button>
    <button type="button" disabled={save.isPending} onClick={() => setEditor(undefined)}>取消</button>
    <ErrorMessage error={save.error} />
  </form>

  if (!current) return <main className="connection">
    <h1>FlowTest Lite</h1>
    {projects.isPending ? <p role="status">正在读取项目…</p> : <>
      <ErrorMessage error={projects.error} />
      <button type="button" onClick={() => void projects.refetch()}>刷新项目</button>
    </>}
  </main>
  return <Workbench key={current.id} projectId={current.id} picker={<div>{picker}{projectForm}</div>}
    page={page} onPage={setPage} runs={runs} onRun={(key, id) => setRuns((previous) => ({ ...previous, [key]: id }))} />
}

function ApiDetail({ projectId, item, environment }: { projectId: string; item: CatalogItem; environment: string }) {
  const [output, setOutput] = useState<'preview' | 'send'>()
  const asset = useQuery({
    queryKey: ['asset', projectId, 'api', item.id, item.revision],
    queryFn: () => call<ApiAsset>('api_get', { api_id: item.id, project_id: projectId }),
  })
  const preview = useMutation({
    mutationFn: () => call<RequestSnapshot>('api_preview', {
      api_id: item.id, project_id: projectId, options: { environment_id: environment || null },
    }),
    onMutate: () => setOutput('preview'),
  })
  const send = useMutation({
    mutationFn: () => call<InterfaceRun>('api_send', {
      api_id: item.id, project_id: projectId, options: { environment_id: environment || null }, detail: 'full',
    }, 45_000),
    onMutate: () => setOutput('send'),
  })
  const pending = preview.isPending || send.isPending
  return <>
    <div className="detail-heading">
      <div><h2>{item.name}</h2><p className="endpoint"><strong>{item.method}</strong> <code>{item.path}</code></p></div>
      <div className="actions">
        <button type="button" disabled={pending} onClick={() => preview.mutate()}>预览请求</button>
        <button type="button" className="primary" disabled={pending} onClick={() => send.mutate()}>发送请求</button>
      </div>
    </div>
    {asset.data?.description && <p>{asset.data.description}</p>}
    <ErrorMessage error={asset.error} />
    {pending && <p role="status" className="muted">{send.isPending ? '正在发送请求…' : '正在生成请求预览…'}</p>}
    {output === 'preview' && <>
      <ErrorMessage error={preview.error} />
      {preview.data && <section className="panel"><h3>请求预览</h3><RequestEvidence request={preview.data} /></section>}
    </>}
    {output === 'send' && <>
      <ErrorMessage error={send.error} />
      {send.data && <section className="panel">
        <div className="spread"><h3>响应</h3><Status value={send.data.execution.status} /></div>
        {send.data.execution.error_message && <p className="error" role="alert">{send.data.execution.error_message}</p>}
        {send.data.response && <ResponseEvidence response={send.data.response} />}
        <Checks checks={send.data.assertions.map((check) => ({ ...check, name: check.target ?? check.kind }))} />
        {Object.keys(send.data.extracted).length > 0 && <JsonPanel title="提取结果" value={send.data.extracted} />}
        {send.data.request && <details className="json-panel"><summary>实际请求</summary>
          <RequestEvidence request={send.data.request} />
        </details>}
      </section>}
    </>}
  </>
}

function FlowDetail({ projectId, item, environment, runId, onRun }: {
  projectId: string; item: CatalogItem; environment: string; runId?: string; onRun: (id: string) => void
}) {
  const [selectedNode, setSelectedNode] = useState<string>()
  const cache = useQueryClient()
  const asset = useQuery({
    queryKey: ['asset', projectId, 'flow', item.id, item.revision],
    queryFn: () => call<Workflow>('workflow_get', { workflow_id: item.id, project_id: projectId }),
  })
  const runKey = ['run', projectId, runId]
  const run = useQuery({
    queryKey: runKey,
    queryFn: () => call<FlowRun>('workflow_run_get', { run_id: runId, project_id: projectId }),
    enabled: Boolean(runId),
    refetchInterval: ({ state }) => state.data?.status === 'running' && !state.error ? 900 : false,
  })
  const stepRecord = run.data?.nodes.find((step) => step.node_id === selectedNode)
  const node = useQuery({
    queryKey: ['run-node', projectId, runId, selectedNode, stepRecord?.occurred_at],
    queryFn: () => call<{ node: NodeExecution }>('workflow_run_get', {
      run_id: runId, node_id: selectedNode, project_id: projectId,
    }),
    enabled: Boolean(runId && selectedNode),
  })
  const start = useMutation({
    mutationFn: () => call<FlowRun>('workflow_run', {
      workflow_id: item.id, project_id: projectId, options: { environment_id: environment || null },
    }),
    onSuccess: (result) => {
      cache.setQueryData(['run', projectId, result.id], result)
      setSelectedNode(undefined)
      onRun(result.id)
    },
  })
  const cancel = useMutation({
    mutationFn: () => call<FlowRun>('workflow_run_cancel', { run_id: runId, project_id: projectId }),
    onSuccess: () => cache.invalidateQueries({ queryKey: runKey }),
  })
  const active = run.data?.status === 'running'
  const definition = asset.data?.definition
  const names = new Map(definition?.nodes.map((step) => [step.id, step.name]))
  const notedNodes = (definition
    ? [...definition.nodes, ...(definition.regions ?? []).flatMap((region) => region.nodes)]
    : []).filter((step) => step.note?.trim())

  return <>
    <div className="detail-heading">
      <div><h2>{item.name}</h2><p className="muted">{item.node_count} 个主画布节点 · 修订 {item.revision}</p></div>
      <div className="actions">
        {active && <button type="button" disabled={cancel.isPending} onClick={() => cancel.mutate()}>取消运行</button>}
        <button type="button" className="primary" disabled={active || start.isPending} onClick={() => start.mutate()}>运行已保存流程</button>
      </div>
    </div>
    <ErrorMessage error={start.error ?? cancel.error ?? run.error} />
    {asset.isPending && <p className="muted" role="status">正在读取流程…</p>}
    <ErrorMessage error={asset.error} />
    {run.data && <section className="panel">
      <div className="spread"><h3>运行结果</h3><Status value={run.data.status} /></div>
      {run.data.error && <p className="error" role="alert">{run.data.error}</p>}
      {run.data.nodes.length === 0 && active && <p className="muted" role="status">等待节点执行…</p>}
      <ul className="run-list">{run.data.nodes.map((step) => <li key={step.node_id}>
        <button type="button" aria-current={step.node_id === selectedNode} onClick={() => setSelectedNode(step.node_id)}>
          <span>{step.name}</span><Status value={step.status} />
        </button>
      </li>)}</ul>
      {selectedNode && <div className="node-evidence">
        {node.isPending && <p role="status" className="muted">加载节点明细…</p>}
        <ErrorMessage error={node.error} />
        {node.data && <NodeEvidence node={node.data.node} />}
      </div>}
    </section>}
    {asset.data && <section className="panel">
      <h3>流程结构</h3>
      <ul className="structure">
        {asset.data.definition.edges.map((edge) => <li key={edge.id}>
          <span>{names.get(edge.source) ?? edge.source}</span>
          <span className="muted">{edge.condition === 'true' ? '真 →' : edge.condition === 'false' ? '假 →' : '→'}</span>
          <span>{names.get(edge.target) ?? edge.target}</span>
        </li>)}
      </ul>
      {notedNodes.length > 0 && <section aria-label="节点备注">
        <h4>节点备注</h4>
        <dl className="flow-notes">
          {notedNodes.map((step) => <div key={step.id}><dt>{step.name}</dt><dd>{step.note}</dd></div>)}
        </dl>
      </section>}
      {Object.keys(asset.data.inputs).length > 0 && <JsonPanel title="已保存的流程输入" value={asset.data.inputs} />}
    </section>}
  </>
}

const style = document.createElement('style')
style.textContent = styles
document.head.append(style)
const root = createRoot(document.getElementById('root')!)
root.render(<main className="connection"><h1>FlowTest Lite</h1><p role="status">正在连接本机工作台…</p></main>)

void host.connect(undefined, { timeout: 15_000 }).then(() => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 4_000, retry: false } } })
  root.render(<QueryClientProvider client={queryClient}><ProjectWorkbench /></QueryClientProvider>)
}).catch(() => {
  root.render(<main className="connection"><h1>FlowTest Lite</h1>
    <p className="error" role="alert">未能连接 Codex。请关闭此页面后从左侧重新打开。</p>
  </main>)
})
