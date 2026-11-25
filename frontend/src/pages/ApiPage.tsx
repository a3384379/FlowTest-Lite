import { useState } from 'react'
import { Alert, App, Button, Card, Checkbox, Drawer, Empty, Form, Input, Modal, Popconfirm, Select, Space, Tag, Upload } from 'antd'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import APIWorkbench from '../features/api-console/APIWorkbench'
import ApiWorkspace from '../features/api-console/ApiWorkspace'
import { previewApi } from '../features/api-console/api-service'
import { useDraftSession } from '../features/drafts/draft-session'
import EnvironmentToolbar, { type EnvironmentSelection } from '../components/EnvironmentToolbar'
import { InterfaceResult } from '../components/RunEvidence'
import {
  apiDetail, apiErrorMessage, client, createAsset, deleteAsset, httpMethods, listAssets, updateAsset,
  type ApiAsset, type ApiInput, type Artifact, type ImportCandidate, type InterfaceRun, type RequestDefinition,
} from '../lib/api'

const defaultRequest: RequestDefinition = {
  method: 'GET', path: '/', query_parameters: [], headers: {}, variables: {},
  body_kind: 'none', body: null, auth_kind: 'none', auth_config: {}, extraction_rules: [], assertions: [],
}
const emptyAsset: ApiInput = { name: '', group: '', description: '', base_url: '', request: defaultRequest }

export default function ApiPage(selection: EnvironmentSelection) {
  const [params, setParams] = useSearchParams()
  const [search, setSearch] = useState('')
  const [group, setGroup] = useState<string>()
  const [method, setMethod] = useState<string>()
  const [editor, setEditor] = useState<ApiInput | null>(null)
  const [editingId, setEditingId] = useState<string>()
  const [importOpen, setImportOpen] = useState(false)
  const [filesOpen, setFilesOpen] = useState(false)
  const [results, setResults] = useState<Record<string, InterfaceRun>>({})
  const { message } = App.useApp()
  const cache = useQueryClient()
  const drafts = useDraftSession()
  const catalog = useQuery({ queryKey: ['apis'], queryFn: () => listAssets('api') })
  const fileList = useQuery({
    queryKey: ['files'],
    queryFn: () => client.get<Artifact[]>('/files').then((res) => res.data),
  })
  const apis = catalog.data ?? []
  const selectedId = params.get('id') ?? apis[0]?.id
  const selected = apis.find((item) => item.id === selectedId)
  const visible = apis.filter((api) =>
    (group === undefined || group === api.group) && (!method || method === api.request.method) &&
    `${api.name} ${api.description} ${api.request.path} ${api.group}`.toLowerCase().includes(search.trim().toLowerCase()),
  )

  const refresh = () => cache.invalidateQueries({ queryKey: ['apis'] })
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
    mutationFn: (apiId: string) => client.post<InterfaceRun>(`/requests/${apiId}/send`, {
      environment_id: selection.environment ?? null,
    }).then((res) => res.data),
    onSuccess: (data, id) => setResults((previous) => ({ ...previous, [id]: data })),
    onError: notify,
  })
  const preview = useMutation({
    mutationFn: (id: string) => previewApi(id, selection.environment),
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

  return (
    <>
      <div className="page-bar">
        <h1>接口</h1>
        <Space wrap>
          <EnvironmentToolbar {...selection} />
          <Button onClick={() => setFilesOpen(true)}>请求附件</Button>
          <Button onClick={() => setImportOpen(true)}>导入接口</Button>
          <Button type="primary" onClick={() => { setEditingId(undefined); setEditor(emptyAsset) }}>新建接口</Button>
        </Space>
      </div>
      {catalog.isError && <Alert type="error" title={apiErrorMessage(catalog.error)} />}
      <ApiWorkspace
        preferenceKey="flowtest-lite:api-layout"
        directory={
          <Card title="接口集合" loading={catalog.isPending}>
            <Space orientation="vertical" className="full-width">
              <Input.Search aria-label="搜索接口" allowClear placeholder="搜索名称、路径或分组" value={search} onChange={(e) => setSearch(e.target.value)} />
              <Select
                aria-label="分组筛选"
                allowClear placeholder="所有分组" value={group} onChange={setGroup}
                className="full-width"
                options={[...new Set(apis.map((api) => api.group))].sort().map((value) => ({ value, label: value || '未分组' }))}
              />
              <Select aria-label="方法筛选" allowClear placeholder="所有方法" value={method} onChange={setMethod} className="full-width" options={httpMethods.map((value) => ({ value }))} />
              {visible.length === 0 && <Empty description="没有匹配的接口" />}
              {visible.map((api) => (
                <button key={api.id} type="button" className="catalog-item" aria-current={selected?.id === api.id} onClick={() => choose(api.id)}>
                  <span><Tag color="blue">{api.request.method}</Tag>{api.name}</span>
                  <small>{api.group ? `${api.group} · ` : ''}{api.request.path}</small>
                </button>
              ))}
            </Space>
          </Card>
        }
        request={
          <APIWorkbench
            key={selected?.id}
            detail={selected ? apiDetail(selected) : undefined}
            loading={catalog.isPending}
            saving={write.isPending}
            previewing={preview.isPending}
            artifacts={fileList.data}
            onRename={() => { if (selected) { setEditingId(selected.id); setEditor(selected) } }}
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
              <Button type="primary" loading={send.isPending} onClick={() => send.mutate(selected.id)}>发送</Button>
            )}
            targetActions={selected && (
              <Space wrap>
                <Button size="small" onClick={() => void duplicate(selected)}>复制接口</Button>
                <Popconfirm title="删除这个接口？" description="引用它的流程会提示接口不存在。" onConfirm={() => remove(selected)}>
                  <Button size="small" danger>删除接口</Button>
                </Popconfirm>
              </Space>
            )}
          />
        }
        response={<Card title="响应"><InterfaceResult result={selected ? results[selected.id] : undefined} /></Card>}
      />
      {editor && <ApiEditDialog value={editor} editing={Boolean(editingId)} saving={write.isPending} close={() => setEditor(null)} save={saveMetadata} />}
      {importOpen && <ImportDialog close={() => setImportOpen(false)} saved={async (assets) => {
        await refresh()
        if (assets[0]) choose(assets[0].id)
        setGroup(undefined)
        setSearch('')
        setMethod(undefined)
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
