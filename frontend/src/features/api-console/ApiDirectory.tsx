import { EditOutlined, FolderAddOutlined, FolderOpenOutlined, FolderOutlined, ImportOutlined, InboxOutlined, PaperClipOutlined, PlusOutlined, SwapOutlined } from '@ant-design/icons'
import { Alert, App, AutoComplete, Button, Checkbox, Dropdown, Empty, Input, Modal, Select, Space, Spin, Tooltip } from 'antd'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { apiErrorMessage, client, httpMethods, type ApiAsset } from '../../lib/api'

export function HttpMethodBadge({ method }: { method: string }) {
  return <span className="http-method" data-method={method}>{method}</span>
}

export default function ApiDirectory({ apis, selected, loading, onChoose, onCreate, onImport, onFiles, onRefresh }: {
  apis: ApiAsset[]; selected?: string; loading: boolean
  onChoose: (id: string) => void
  onCreate: (group: string) => void
  onImport: () => void
  onFiles: () => void
  onRefresh: () => Promise<void>
}) {
  const [group, setGroup] = useState<string | null>(null)
  const [method, setMethod] = useState<string>()
  const [search, setSearch] = useState('')
  const [checked, setChecked] = useState<string[]>([])
  const [dialog, setDialog] = useState<{ action: 'create' | 'rename' | 'move'; name: string }>()
  const [name, setName] = useState('')
  const [working, setWorking] = useState(false)
  const { message, modal } = App.useApp()
  const catalog = useQuery({ queryKey: ['api-groups'], queryFn: () => client.get<string[]>('/groups').then((res) => res.data) })
  const groups = [...new Set([...(catalog.data ?? []), ...apis.map((api) => api.group).filter(Boolean)])].sort()
  const normalized = search.trim().toLowerCase()
  const visible = apis.filter((api) =>
    (group === null || group === api.group) && (!method || method === api.request.method) &&
    `${api.name} ${api.description} ${api.request.path}`.toLowerCase().includes(normalized),
  )
  const checkedIds = checked.filter((key) => apis.some((api) => api.id === key))
  const numVisible = visible.filter((api) => checkedIds.includes(api.id)).length
  function open(action: 'create' | 'rename' | 'move', previous = '') {
    setName(action === 'rename' ? previous : '')
    setDialog({ action, name: previous })
  }
  async function finish() {
    if (!dialog) return
    setWorking(true)
    try {
      if (dialog.action === 'move') {
        await client.post('/groups/move', { ids: checkedIds, group: name.trim() })
        setChecked([])
        setGroup(name.trim())
      } else {
        await client.put('/groups', { name: name.trim(), previous: dialog.action === 'rename' ? dialog.name : null })
        setGroup(name.trim())
      }
      await onRefresh()
      setDialog(undefined)
    } catch (error) { message.error(apiErrorMessage(error)) }
    finally { setWorking(false) }
  }
  function remove(name: string) {
    modal.confirm({
      title: `删除分组「${name}」？`,
      content: '组内的接口将移动到「未分组」。',
      okText: '删除分组',
      async onOk() {
        try {
          await client.delete('/groups', { params: { name } })
          if (group === name) setGroup(null)
          await onRefresh()
        } catch (error) { message.error(apiErrorMessage(error)); throw error }
      },
    })
  }
  function count(name: string | null) {
    return name === null ? apis.length : apis.filter((api) => api.group === name).length
  }
  const groupRows = [
    { key: null, label: '全部接口', icon: <FolderOpenOutlined /> },
    ...groups.map((key) => ({ key, label: key, icon: <FolderOutlined /> })),
    { key: '', label: '未分组', icon: <InboxOutlined /> },
  ]
  return (
    <section className="api-directory" aria-label="接口目录">
      <header className="directory-heading">
        <h1>接口集合 <small>{apis.length}</small></h1>
        <Tooltip title="新建分组"><Button type="text" size="small" icon={<FolderAddOutlined />} aria-label="新建分组" onClick={() => open('create')} /></Tooltip>
      </header>
      <div className="directory-actions">
        <Button icon={<PlusOutlined />} onClick={() => onCreate(group ?? '')}>新建接口</Button>
        <Space size={2}>
          <Tooltip title="导入接口"><Button type="text" icon={<ImportOutlined />} aria-label="导入接口" onClick={onImport} /></Tooltip>
          <Tooltip title="请求附件"><Button type="text" icon={<PaperClipOutlined />} aria-label="请求附件" onClick={onFiles} /></Tooltip>
        </Space>
      </div>
      <div className="directory-filters">
        <Input.Search placeholder="搜索名称、路径或说明" allowClear aria-label="搜索接口" value={search} onChange={(event) => setSearch(event.target.value)} />
        <Select aria-label="接口方法筛选" placeholder="全部方法" allowClear value={method} onChange={setMethod} options={httpMethods.map((value) => ({ value }))} />
      </div>
      <div className="directory-scroll">
        {catalog.error && <Alert type="error" title={apiErrorMessage(catalog.error)} />}
        <nav className="directory-groups" aria-label="接口分组">
          {groupRows.map((row) => (
            <div key={row.key ?? 'all-groups'} className="directory-group" data-active={group === row.key}>
              <button type="button" aria-pressed={group === row.key} onClick={() => setGroup(row.key)}>
                {row.icon}<span>{row.label}</span><small>{count(row.key)}</small>
              </button>
              {row.key && <Dropdown trigger={['click']} menu={{ items: [
                { key: 'new', label: '在分组内新建接口' }, { key: 'rename', label: '重命名分组' }, { key: 'delete', label: '删除分组', danger: true },
              ], onClick: ({ key }) => {
                if (!row.key) return
                if (key === 'new') onCreate(row.key)
                if (key === 'rename') open('rename', row.key)
                if (key === 'delete') remove(row.key)
              } }}>
                <Button type="text" size="small" icon={<EditOutlined />} aria-label={`管理分组 ${row.label}`} />
              </Dropdown>}
            </div>
          ))}
        </nav>
        <div className="directory-selection">
          <Checkbox
            aria-label="全选当前结果"
            checked={Boolean(visible.length && numVisible === visible.length)}
            indeterminate={numVisible > 0 && numVisible < visible.length}
            disabled={!visible.length}
            onChange={(event) => setChecked(event.target.checked
              ? [...new Set([...checkedIds, ...visible.map((api) => api.id)])]
              : checkedIds.filter((key) => !visible.some((api) => api.id === key)))}
          >{checkedIds.length ? `已选 ${checkedIds.length} 项` : `${visible.length} 个接口`}</Checkbox>
          {checkedIds.length > 0 && <Button size="small" type="text" icon={<SwapOutlined />} onClick={() => open('move')}>移动接口</Button>}
        </div>
        {loading && <div className="workspace-empty"><Spin /></div>}
        {!loading && !visible.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的接口" />}
        {visible.map((api) => (
          <div key={api.id} className="directory-entry" data-active={selected === api.id}>
            <Checkbox aria-label={`勾选 ${api.name}`} checked={checkedIds.includes(api.id)}
              onChange={(event) => setChecked(event.target.checked ? [...checkedIds, api.id] : checkedIds.filter((id) => id !== api.id))} />
            <button type="button" aria-current={selected === api.id} title={api.name} onClick={() => onChoose(api.id)}>
              <span><HttpMethodBadge method={api.request.method} /><strong>{api.name}</strong></span>
              <code title={api.request.path}>{api.request.path}</code>
            </button>
          </div>
        ))}
      </div>
      {dialog && (
        <Modal open title={dialog.action === 'move' ? '移动接口' : dialog.action === 'rename' ? '重命名分组' : '新建分组'}
          onCancel={() => setDialog(undefined)} onOk={() => void finish()} confirmLoading={working} okText="保存"
          okButtonProps={{ disabled: dialog.action !== 'move' && !name.trim() }}>
          {dialog.action === 'move'
            ? <AutoComplete className="full-width" aria-label="目标分组" placeholder="输入或选择分组，留空为未分组"
              value={name} onChange={setName} options={groups.map((value) => ({ value }))} />
            : <Input aria-label="分组名称" maxLength={100} value={name} onChange={(event) => setName(event.target.value)} />}
        </Modal>
      )}
    </section>
  )
}
