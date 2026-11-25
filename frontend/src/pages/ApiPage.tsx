import { DownloadOutlined, EditOutlined, ImportOutlined, MoreOutlined, PaperClipOutlined, PlayCircleOutlined, PlusOutlined } from '@ant-design/icons'
import { useState, useSyncExternalStore } from 'react'
import { Alert, App, Button, Checkbox, Drawer, Dropdown, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Upload } from 'antd'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import APIWorkbench from '../features/api-console/APIWorkbench'
import ApiWorkspace from '../features/api-console/ApiWorkspace'
import ApiDirectory, { HttpMethodBadge } from '../features/api-console/ApiDirectory'
import AssetTabs from '../components/AssetTabs'
import { useDraftSession } from '../features/drafts/draft-session'
import { InterfaceResult } from '../components/RunEvidence'
import {
  apiDetail, apiErrorMessage, client, createAsset, deleteAsset, listAssets, updateAsset,
  type ApiAsset, type ApiInput, type Artifact, type ImportCandidate, type InterfaceRun, type RequestDefinition, type RequestSnapshot,
} from '../lib/api'

const defaultRequest: RequestDefinition = {
  method: 'GET', path: '/', query_parameters: [], headers: {}, variables: {},
  body_kind: 'none', body: null, auth_kind: 'none', auth_config: {}, extraction_rules: [], assertions: [],
}
const emptyAsset: ApiInput = { name: '', group: '', description: '', base_url: '', request: defaultRequest }

export default function ApiPage({ environment }: { environment?: string }) {
  const [params, setParams] = useSearchParams()
  const [editor, setEditor] = useState<ApiInput | null>(null)
  const [editingId, setEditingId] = useState<string>()
  const [importOpen, setImportOpen] = useState(false)
  const [filesOpen, setFilesOpen] = useState(false)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [executionOptions, setExecutionOptions] = useState<Record<string, RequestRunOptions>>({})
  const { message, modal } = App.useApp()
  const cache = useQueryClient()
  const drafts = useDraftSession()
  useSyncExternalStore(drafts.subscribe, drafts.snapshot)
  const catalog = useQuery({ queryKey: ['apis'], queryFn: () => listAssets('api') })
  const fileList = useQuery({
    queryKey: ['files'],
    queryFn: () => client.get<Artifact[]>('/files').then((res) => res.data),
  })
  const apis = catalog.data ?? []
  const selected = apis.find((item) => item.id === params.get('id')) ?? apis[0]
  const history = useQuery({
    queryKey: ['api-runs', selected?.id],
    queryFn: () => Promise.resolve([] as InterfaceRun[]),
    enabled: false,
  })
  const options = selected && executionOptions[selected.id]
  function runOptions(id: string) {
    return { environment_id: environment ?? null, ...executionOptions[id] }
  }
  async function refresh() {
    const current = await listAssets('api')
    for (const item of current) {
      const prior = apis.find((asset) => asset.id === item.id)
      const draft = drafts.apis.get(item.id)
      if (prior && draft?.baseVersion === prior.revision &&
        JSON.stringify(prior.request) === JSON.stringify(item.request)) {
        drafts.apis.set(item.id, { ...draft, baseVersion: item.revision })
      }
      cache.setQueryData(['api-detail', item.id], apiDetail(item))
    }
    cache.setQueryData(['apis'], current)
    await cache.invalidateQueries({ queryKey: ['api-groups'] })
  }
  function choose(id: string) { setParams({ id }) }
  function put(asset: ApiAsset) {
    cache.setQueryData<ApiAsset[]>(['apis'], (old) => [asset, ...(old ?? []).filter((item) => item.id !== asset.id)])
    cache.setQueryData(['api-detail', asset.id], apiDetail(asset))
  }
  function notify(error: unknown) { message.error(apiErrorMessage(error)) }

  const write = useMutation({
    mutationFn: ({ asset, previous, revision }: { asset: ApiInput; previous?: ApiAsset; revision?: number }) =>
      previous ? updateAsset('api', previous.id, revision ?? previous.revision, asset) : createAsset('api', asset),
    onSuccess: put,
  })
  const send = useMutation({
    mutationFn: (apiId: string) => client.post<InterfaceRun>(`/requests/${apiId}/send`, runOptions(apiId)).then((res) => res.data),
    onSuccess: (data, id) => cache.setQueryData<InterfaceRun[]>(['api-runs', id], (prior) => [data, ...(prior ?? []).slice(0, 11)]),
    onError: notify,
  })
  const preview = useMutation({
    mutationFn: (id: string) => client.post<RequestSnapshot>(`/requests/${id}/preview`, runOptions(id)).then((res) => res.data),
    onError: notify,
  })

  async function saveMetadata(fields: Omit<ApiInput, 'request'> & { path?: string }) {
    if (!editor) return
    const previous = apis.find((item) => item.id === editingId)
    const { path, ...metadata } = fields
    try {
      const asset = await write.mutateAsync({
        asset: { ...metadata, request: { ...editor.request, ...(path ? { path } : {}) } }, previous,
      })
      if (previous) {
        const draft = drafts.apis.get(previous.id)
        if (draft?.baseVersion === previous.revision) {
          drafts.apis.set(previous.id, { ...draft, baseVersion: asset.revision })
        }
      }
      void cache.invalidateQueries({ queryKey: ['api-groups'] })
      choose(asset.id)
      setEditor(null)
    } catch (error) { notify(error) }
  }

  async function duplicate(api: ApiAsset) {
    const { id: _id, updated_at: _stamp, revision: _rev, ...asset } = api
    try {
      const copy = await write.mutateAsync({ asset: { ...asset, name: `${asset.name.slice(0, 190)} 副本` } })
      choose(copy.id)
    } catch (error) { notify(error) }
  }

  async function remove(api: ApiAsset) {
    try {
      await deleteAsset('api', api.id)
      drafts.apis.delete(api.id)
      drafts.markUnsafe(api.id, false)
      cache.setQueryData<ApiAsset[]>(['apis'], (old) => old?.filter((item) => item.id !== api.id))
      setParams({})
    } catch (error) { notify(error) }
  }

  function create(group = '') {
    setEditingId(undefined)
    setEditor({ ...emptyAsset, group })
  }

  async function exportCurl(api: ApiAsset) {
    try {
      const prepared = await preview.mutateAsync(api.id)
      const content = curlCommand(prepared, api.request.body_kind, fileList.data ?? [])
      const url = URL.createObjectURL(new Blob([content + '\n'], { type: 'text/plain;charset=utf-8' }))
      const download = document.createElement('a')
      download.href = url
      download.download = `${api.name.replace(/[\\/:*?"<>|]/g, '_')}.curl.txt`
      download.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch {
      // The preview mutation handles error feedback.
    }
  }
  return (
    <>
      <div className="page-bar">
        <h1>接口管理</h1>
        <Space wrap size={8}>
          <Button icon={<PaperClipOutlined />} onClick={() => setFilesOpen(true)}>请求附件</Button>
          <Button icon={<ImportOutlined />} onClick={() => setImportOpen(true)}>导入接口</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => create()}>新建接口</Button>
        </Space>
      </div>
      <AssetTabs label="已打开接口" active={selected?.id} onSelect={choose} entries={apis.map((api) => ({
        id: api.id, name: api.name, icon: <HttpMethodBadge method={api.request.method} />, dirty: drafts.apis.has(api.id),
      }))} />
      {catalog.isError && <Alert type="error" title={apiErrorMessage(catalog.error)} />}
      <ApiWorkspace preferenceKey="flowtest-lite:api-layout"
        directory={<ApiDirectory apis={apis} selected={selected?.id} loading={catalog.isPending}
          onChoose={choose} onCreate={create} onRefresh={refresh} />}
        workbench={(renderPanels) => (
          <APIWorkbench
            key={selected?.id}
            detail={selected ? apiDetail(selected) : undefined}
            loading={catalog.isPending}
            saving={write.isPending}
            previewing={preview.isPending}
            artifacts={fileList.data}
            renderPanels={renderPanels}
            response={<InterfaceResult key={selected?.id} history={history.data ?? []} configured={selected?.request.assertions ?? []} sending={send.isPending && send.variables === selected?.id} />}
            onPreview={() => selected ? preview.mutateAsync(selected.id) : Promise.resolve(null)}
            onSave={async ({ base_version, ...request }) => {
              if (!selected) throw new Error('请选择接口')
              const { name, group, description, base_url } = selected
              const saved = await write.mutateAsync({
                asset: { name, group, description, base_url, request }, previous: selected, revision: base_version,
              })
              return apiDetail(saved).version
            }}
            requestActions={selected && (
              <Button type="primary" icon={<PlayCircleOutlined />} loading={send.isPending && send.variables === selected.id}
                onClick={() => send.mutate(selected.id)}>发送请求</Button>
            )}
            actions={selected && (
              <Dropdown trigger={['click']} menu={{ items: [
                { key: 'runtime', label: '本次请求参数' },
                { key: 'edit', label: '编辑接口信息', icon: <EditOutlined /> },
                { key: 'duplicate', label: '复制接口' },
                { key: 'curl', label: '导出 cURL', icon: <DownloadOutlined /> },
                { key: 'delete', label: '删除接口', danger: true },
              ], onClick: ({ key }) => {
                if (key === 'runtime') setOptionsOpen(true)
                if (key === 'edit') { setEditingId(selected.id); setEditor(selected) }
                if (key === 'duplicate') void duplicate(selected)
                if (key === 'curl') void exportCurl(selected)
                if (key === 'delete') modal.confirm({
                  title: '删除这个接口？', content: '引用它的流程会提示接口不存在。',
                  okText: '删除接口', okButtonProps: { danger: true }, onOk: () => remove(selected),
                })
              } }}>
                <Button type="text" size="small" icon={<MoreOutlined />} aria-label="更多接口操作" />
              </Dropdown>
            )}
          />
        )}
      />
      {selected && optionsOpen && <RuntimeOptions value={options} onClose={() => setOptionsOpen(false)}
        onApply={(value) => { setExecutionOptions((old) => ({ ...old, [selected.id]: value })); setOptionsOpen(false) }} />}
      {editor && <ApiEditDialog value={editor} editing={Boolean(editingId)} saving={write.isPending} close={() => setEditor(null)} save={saveMetadata} />}
      {importOpen && <ImportDialog close={() => setImportOpen(false)} saved={async (assets) => {
        await refresh()
        if (assets[0]) choose(assets[0].id)
        setImportOpen(false)
      }} />}
      <Drawer title="请求附件" size={460} open={filesOpen} onClose={() => setFilesOpen(false)}>
        <Upload
          multiple={false}
          showUploadList={false}
          beforeUpload={(file) => {
            const data = new FormData()
            data.append('file', file)
            void client.post('/files', data).then(() => cache.invalidateQueries({ queryKey: ['files'] })).catch(notify)
            return false
          }}
        ><Button>上传文件</Button></Upload>
        <div className="file-list">
          {fileList.error && <Alert type="error" title={apiErrorMessage(fileList.error)} />}
          {fileList.data?.map((file) => (
            <div key={file.id} className="file-row">
              <span>{file.filename} · {file.size_bytes} 字节</span>
              <Popconfirm title="删除本地附件？" onConfirm={() => client.delete(`/files/${file.id}`)
                .then(() => cache.invalidateQueries({ queryKey: ['files'] })).catch(notify)}>
                <Button size="small" danger>删除</Button>
              </Popconfirm>
            </div>
          ))}
        </div>
      </Drawer>
    </>
  )
}

function ApiEditDialog({ value, editing, saving, close, save }: {
  value: ApiInput; editing: boolean; saving: boolean; close: () => void
  save: (input: Omit<ApiInput, 'request'> & { path?: string }) => Promise<void>
}) {
  const [form] = Form.useForm()
  return (
    <Modal open title={editing ? '编辑接口信息' : '新建接口'} onCancel={close} onOk={() => form.submit()} confirmLoading={saving} okText="保存">
      <Form form={form} layout="vertical" initialValues={{ ...value, path: value.request.path }} onFinish={(fields) => void save({
        name: fields.name.trim(), group: fields.group?.trim() ?? '', description: fields.description?.trim() ?? '',
        base_url: fields.base_url?.trim() ?? '', path: fields.path?.trim(),
      })}>
        <Form.Item name="name" label="接口名称" rules={[{ required: true, whitespace: true }]}><Input maxLength={200} /></Form.Item>
        <Form.Item name="group" label="分组"><Input maxLength={100} placeholder="留空为未分组" /></Form.Item>
        {!editing && <Form.Item name="path" label="请求 URL 或路径" rules={[{ required: true, whitespace: true }]}><Input placeholder="/orders/{{id}}" /></Form.Item>}
        <Form.Item name="base_url" label="接口默认基础地址"><Input placeholder="留空使用公共地址" /></Form.Item>
        <Form.Item name="description" label="说明"><Input.TextArea rows={2} maxLength={2000} /></Form.Item>
      </Form>
    </Modal>
  )
}

function ImportDialog({ close, saved }: { close: () => void; saved: (assets: ApiAsset[]) => Promise<void> }) {
  const [kind, setKind] = useState('auto')
  const [content, setContent] = useState('')
  const [url, setUrl] = useState('')
  const [group, setGroup] = useState('')
  const [candidates, setCandidates] = useState<ImportCandidate[]>()
  const [checked, setChecked] = useState<number[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function confirm() {
    setBusy(true)
    setError('')
    try {
      if (!candidates) {
        const { data } = await client.post<ImportCandidate[]>('/import/preview', { source_type: kind, content, url })
        setCandidates(data)
        setChecked(data.map((_, index) => index))
      } else {
        const assets = checked.map((index) => ({ ...candidates[index].asset, group }))
        const { data } = await client.post<ApiAsset[]>('/import/save', assets)
        await saved(data)
      }
    } catch (cause) { setError(apiErrorMessage(cause)) }
    finally { setBusy(false) }
  }
  return (
    <Modal open width={700} title="导入接口" onCancel={close} onOk={() => void confirm()} okText={candidates ? '保存所选接口' : '解析预览'}
      okButtonProps={{ disabled: candidates ? !checked.length : !content.trim() && !url.trim() }} confirmLoading={busy}>
      <Space orientation="vertical" className="full-width" size="middle">
        {error && <Alert type="error" title={error} />}
        {candidates ? (
          <>
            <Space><Button onClick={() => setCandidates(undefined)}>返回输入</Button><Input aria-label="导入分组" placeholder="保存到分组" value={group} onChange={(e) => setGroup(e.target.value)} /></Space>
            <Checkbox.Group value={checked} onChange={setChecked} className="import-candidates">
              {candidates.map((item, index) => (
                <Checkbox key={index} value={index}>
                  {item.asset.request.method} {item.asset.request.path} · {item.asset.name}
                  {item.diagnostics.map((diagnostic, i) => <div key={i} className="import-diagnostic">{diagnostic.message}</div>)}
                </Checkbox>
              ))}
            </Checkbox.Group>
          </>
        ) : (
          <>
            <Select aria-label="导入格式" className="full-width" value={kind} onChange={setKind} options={
              [['auto', '自动识别'], ['curl', 'cURL'], ['openapi3', 'OpenAPI'], ['swagger2', 'Swagger'], ['postman', 'Postman'], ['har', 'HAR'], ['bruno', 'Bruno']].map(([value, label]) => ({ value, label }))
            } />
            <Input aria-label="接口文档 URL" placeholder="HTTP(S) 文档 URL" value={url} onChange={(e) => { setUrl(e.target.value); setContent('') }} />
            <Input.TextArea aria-label="导入文档" rows={7} placeholder="粘贴 cURL 命令、JSON 或 YAML" value={content} onChange={(e) => { setContent(e.target.value); setUrl('') }} />
            <Upload showUploadList={false} beforeUpload={(file) => {
              if (file.size > 4_000_000) setError('导入文件最大 4 MB')
              else void file.text().then((text) => { setContent(text); setUrl('') })
              return false
            }}><Button>打开本地文档</Button></Upload>
          </>
        )}
      </Space>
    </Modal>
  )
}

type RequestRunOptions = { runtime_variables: Record<string, unknown>; timeout_seconds: number }

function RuntimeOptions({ value, onApply, onClose }: {
  value?: RequestRunOptions; onApply: (value: RequestRunOptions) => void; onClose: () => void
}) {
  const [form] = Form.useForm<{ variables: string; timeout: number }>()
  const [error, setError] = useState('')
  return (
    <Modal open title="本次请求参数" onCancel={onClose} onOk={() => form.submit()} okText="应用">
      {error && <Alert type="error" title={error} />}
      <Form form={form} layout="vertical" initialValues={{
        variables: JSON.stringify(value?.runtime_variables ?? {}, null, 2), timeout: value?.timeout_seconds ?? 30,
      }} onFinish={({ variables, timeout }) => {
        try {
          const parsed: unknown = JSON.parse(variables)
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('变量应为 JSON 对象')
          onApply({ runtime_variables: parsed as Record<string, unknown>, timeout_seconds: timeout })
        } catch (cause) { setError(apiErrorMessage(cause)) }
      }}>
        <Form.Item name="variables" label="运行时变量（JSON）" extra="用于预览及发送，覆盖已保存的同名变量。">
          <Input.TextArea rows={5} className="code-input" aria-label="运行时变量" />
        </Form.Item>
        <Form.Item name="timeout" label="超时（秒）" rules={[{ required: true }]}><InputNumber min={0.1} max={300} /></Form.Item>
      </Form>
    </Modal>
  )
}

function curlCommand(request: RequestSnapshot, kind: RequestDefinition['body_kind'], artifacts: Artifact[]) {
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'"
  const parts = ['curl', '-X', request.method, quote(request.url)]
  const headers = { ...request.headers }
  if (kind === 'multipart') {
    for (const key of Object.keys(headers)) if (key.toLowerCase() === 'content-type') delete headers[key]
  } else if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
    if (kind === 'json') headers['Content-Type'] = 'application/json'
    if (kind === 'form') headers['Content-Type'] = 'application/x-www-form-urlencoded'
  }
  for (const [key, value] of Object.entries(headers)) parts.push('-H', quote(`${key}: ${value}`))
  if (kind === 'multipart') {
    const multipart = request.body as { fields: Record<string, string>; files: Array<{ field: string; artifact_id: string }> }
    for (const [key, value] of Object.entries(multipart.fields ?? {})) parts.push('--form-string', quote(`${key}=${value}`))
    for (const { field, artifact_id } of multipart.files ?? []) {
      const name = artifacts.find((item) => item.id === artifact_id)?.filename ?? 'filename'
      parts.push('--form', quote(`${field}=@./${name}`))
    }
  } else if (kind === 'json') {
    parts.push('--data-raw', quote(JSON.stringify(request.body)))
  } else if (kind === 'form' && request.body && typeof request.body === 'object') {
    const form = new URLSearchParams()
    for (const [key, value] of Object.entries(request.body)) {
      for (const item of Array.isArray(value) ? value : [value]) form.append(key, String(item ?? ''))
    }
    parts.push('--data-raw', quote(form.toString()))
  } else if (kind === 'raw') {
    parts.push('--data-raw', quote(String(request.body ?? '')))
  }
  return parts.join(' ')
}
