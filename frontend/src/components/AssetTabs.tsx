import { CloseOutlined } from '@ant-design/icons'
import { useEffect, useState, type ReactNode } from 'react'

type Entry = { id: string; name: string; icon?: ReactNode; dirty?: boolean }

export default function AssetTabs({ entries, active, onSelect, label, hideSingle = false }: {
  entries: Entry[]; active?: string; onSelect: (id: string) => void; label: string; hideSingle?: boolean
}) {
  const [opened, setOpened] = useState<string[]>([])
  useEffect(() => {
    if (active) setOpened((current) => current.includes(active) ? current : [...current.slice(-11), active])
  }, [active])
  const tabs = (active && !opened.includes(active) ? [...opened, active] : opened)
    .flatMap((id) => entries.find((entry) => entry.id === id) ?? [])
  if (!tabs.length || (hideSingle && tabs.length === 1)) return null
  function close(id: string, index: number) {
    const neighbor = tabs[index + 1] ?? tabs[index - 1]
    if (id === active && neighbor) onSelect(neighbor.id)
    setOpened((current) => current.filter((entry) => entry !== id))
  }
  return (
    <nav className="asset-tabs" aria-label={label}>
      {tabs.map((tab, index) => (
        <div key={tab.id} className="asset-tab" data-active={tab.id === active}>
          <button type="button" className="asset-tab-label" aria-current={tab.id === active} onClick={() => onSelect(tab.id)}>
            {tab.icon}<span>{tab.name}</span>{tab.dirty && <span className="unsaved-dot" aria-label="未保存" />}
          </button>
          {tabs.length > 1 && <button type="button" className="asset-tab-close" onClick={() => close(tab.id, index)} aria-label={`关闭 ${tab.name}`}><CloseOutlined /></button>}
        </div>
      ))}
    </nav>
  )
}
