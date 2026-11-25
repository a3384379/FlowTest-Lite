import { ApiOutlined, AppstoreOutlined, BranchesOutlined, CheckCircleOutlined, ClockCircleOutlined, ExportOutlined, FlagOutlined } from '@ant-design/icons'
import { Button, Empty, Input, Select } from 'antd'
import { useState } from 'react'
import type { ApiDefinition } from '../lib/api'
import { controlCapabilityLabel, type ControlBlockKind } from './editor/control-blocks'
import type { PaletteNodeType } from './workflow-graph'

export type NodeChoice = 'api' | PaletteNodeType | `control.${ControlBlockKind}`
export const NODE_DRAG_FORMAT = 'application/x-flowtest-lite-node'
const controls: ControlBlockKind[] = ['repeat', 'foreach', 'while', 'do_while', 'until', 'if', 'switch', 'parallel', 'try', 'group', 'fail']

const groups = [
  { key: 'request', label: '请求', items: [{ id: 'api', label: 'HTTP 请求', icon: <ApiOutlined /> }] as const },
  { key: 'data', label: '数据与校验', items: [
    { id: 'extract', label: '提取变量', icon: <ExportOutlined /> },
    { id: 'assert', label: '断言校验', icon: <CheckCircleOutlined /> },
  ] as const },
  { key: 'flow', label: '流程控制', items: [
    { id: 'delay', label: '等待', icon: <ClockCircleOutlined /> },
    { id: 'condition', label: '真假分支', icon: <BranchesOutlined /> },
    ...controls.map((value) => ({ id: `control.${value}` as const, label: controlCapabilityLabel(`flow.control.${value}`) ?? value, icon: <AppstoreOutlined /> })),
    { id: 'end', label: '结束', icon: <FlagOutlined /> },
  ] as const },
]

export function nodeChoice(value: string): value is NodeChoice {
  return groups.some((group) => group.items.some((item) => item.id === value))
}

export default function WorkflowNodeLibrary({ apis, apiId, setApiId, onAdd, open }: {
  apis: ApiDefinition[]; apiId?: string; setApiId: (id: string) => void
  onAdd: (type: NodeChoice) => void; open: boolean
}) {
  const [search, setSearch] = useState('')
  const query = search.trim().toLowerCase()
  const filtered = groups.map((group) => ({
    ...group,
    items: group.items.filter((item) => `${group.label} ${item.id} ${item.label}`.toLowerCase().includes(query)),
  })).filter((group) => group.items.length > 0)
  return (
    <aside className="lite-node-library" data-open={open} aria-label="节点库">
      <header className="pane-heading"><h2>节点库</h2></header>
      <div className="node-library-search">
        <Input.Search aria-label="搜索节点类型" placeholder="搜索名称或类型" allowClear value={search}
          onChange={(event) => setSearch(event.target.value)} />
      </div>
      <div className="node-library-scroll">
        {filtered.map((group) => (
          <section key={group.key} className="lite-node-group">
            <h3>{group.label}</h3>
            {group.items.map((item) => {
              const disabled = item.id === 'api' && !apiId
              return (
                <div key={item.id} className="lite-node-option" data-kind={group.key}>
                  <Button type="text" block icon={item.icon}
                    aria-label={`添加${item.label}`} disabled={disabled}
                    draggable={!disabled}
                    onDragStart={(event) => {
                      event.dataTransfer.setData(NODE_DRAG_FORMAT, item.id)
                      event.dataTransfer.effectAllowed = 'copy'
                    }}
                    onClick={() => onAdd(item.id)}>
                    {item.label}
                  </Button>
                  {item.id === 'api' && <Select className="node-library-api-select" size="small" aria-label="要添加的接口"
                    placeholder="选择已保存的接口" showSearch optionFilterProp="label"
                    value={apiId} onChange={setApiId} options={apis.map((api) => ({ value: api.id, label: api.name }))} />}
                </div>
              )
            })}
          </section>
        ))}
        {filtered.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的节点" />}
      </div>
      <div className="node-library-footer">点击添加，或拖到画布</div>
    </aside>
  )
}
