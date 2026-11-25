import { LayoutOutlined, MenuFoldOutlined, MenuUnfoldOutlined } from '@ant-design/icons'
import { Button, Dropdown, Segmented, Tooltip } from 'antd'
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type PointerEvent,
} from 'react'

type Preferences = {
  directoryWidth: number
  requestShare: number
  layout: 'side' | 'stacked'
  directoryCollapsed: boolean
  responseCollapsed: boolean
}
type MobilePanel = 'directory' | 'request' | 'response'
const defaults: Readonly<Preferences> = {
  directoryWidth: 240,
  requestShare: 52,
  layout: 'side',
  directoryCollapsed: false,
  responseCollapsed: false,
}

function bounded(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback
}
function readPreferences(key: string): Preferences {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(key) ?? '{}')
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...defaults }
    const value = raw as Record<string, unknown>
    return {
      directoryWidth: bounded(value.directoryWidth, 240, 180, 340),
      requestShare: bounded(value.requestShare, 52, 30, 70),
      layout: value.layout === 'stacked' ? 'stacked' : 'side',
      directoryCollapsed: value.directoryCollapsed === true,
      responseCollapsed: value.responseCollapsed === true,
    }
  } catch {
    return { ...defaults }
  }
}

export default function ApiWorkspace({
  preferenceKey,
  resourceId,
  tabs,
  directory,
  workbench,
}: {
  preferenceKey: string
  resourceId?: string
  tabs: ReactNode
  directory: (showRequest: () => void) => ReactNode
  workbench: (renderPanels: (request: ReactNode, response: ReactNode) => ReactNode, showResponse: () => void) => ReactNode
}) {
  const [preferences, setPreferences] = useState(() => readPreferences(preferenceKey))
  const [storageError, setStorageError] = useState(false)
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>(resourceId ? 'request' : 'directory')
  useEffect(() => {
    if (resourceId) setMobilePanel('request')
  }, [resourceId])
  function update(patch: Partial<Preferences>, persist = true) {
    const next = { ...preferences, ...patch }
    setPreferences(next)
    if (!persist) return
    try {
      localStorage.setItem(preferenceKey, JSON.stringify(next))
      setStorageError(false)
    } catch {
      setStorageError(true)
    }
  }
  function renderPanels(request: ReactNode, response: ReactNode) {
    return (
        <div
          className={`api-workspace-main api-layout-main layout-${preferences.layout}${preferences.responseCollapsed ? ' response-collapsed' : ''}`}
          style={
            {
              '--api-request-share': `${preferences.requestShare}fr`,
              '--api-response-share': `${100 - preferences.requestShare}fr`,
            } as CSSProperties
          }
        >
          <div className="api-layout-request">{request}</div>
          <ResizeHandle
            label="调整请求响应比例"
            value={preferences.requestShare}
            min={30}
            max={70}
            axis={preferences.layout === 'side' ? 'x' : 'y'}
            unit="percent"
            disabled={preferences.responseCollapsed}
            onChange={(value) => update({ requestShare: value }, false)}
            onCommit={(value) => update({ requestShare: value })}
          />
          <div className="api-layout-response">{response}</div>
        </div>
    )
  }
  return (
    <section className="request-workspace" aria-label="接口工作台">
      <div className="request-workspace-top">
        <div className="request-open-tabs">{tabs}</div>
        <div className="request-layout-controls" aria-label="接口工作区布局">
          <Tooltip title={preferences.directoryCollapsed ? '展开目录' : '收起目录'}>
            <Button
              type="text" aria-label={preferences.directoryCollapsed ? '展开目录' : '收起目录'}
              aria-expanded={!preferences.directoryCollapsed}
              icon={preferences.directoryCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={() => update({ directoryCollapsed: !preferences.directoryCollapsed })}
            />
          </Tooltip>
          <Dropdown trigger={['click']} menu={{
            selectable: true,
            selectedKeys: [preferences.layout],
            items: [
              { key: 'side', label: '左右并排' },
              { key: 'stacked', label: '上下分栏' },
              { type: 'divider' },
              { key: 'response', label: preferences.responseCollapsed ? '展开响应' : '收起响应' },
            ],
            onClick: ({ key }) => {
              if (key === 'response') update({ responseCollapsed: !preferences.responseCollapsed })
              if (key === 'side' || key === 'stacked') update({ layout: key })
            },
          }}>
            <Button type="text" icon={<LayoutOutlined />} aria-label="布局设置">布局</Button>
          </Dropdown>
        </div>
        {storageError && <small role="status">布局偏好未保存</small>}
      </div>
      <div className="api-mobile-panel-tabs">
        <Segmented aria-label="接口工作区面板" block value={mobilePanel} onChange={setMobilePanel}
          options={[
            { value: 'directory', label: '接口目录' },
            { value: 'request', label: '请求' },
            { value: 'response', label: '响应' },
          ]} />
      </div>
      <div
        className={`api-workspace api-resizable-workspace${preferences.directoryCollapsed ? ' directory-collapsed' : ''}`}
        data-mobile-panel={mobilePanel}
        style={{ '--api-directory-width': `${preferences.directoryWidth}px` } as CSSProperties}
      >
        <div className="api-layout-directory">{directory(() => setMobilePanel('request'))}</div>
        <ResizeHandle
          label="调整接口目录宽度"
          value={preferences.directoryWidth}
          min={180}
          max={340}
          axis="x"
          unit="pixel"
          disabled={preferences.directoryCollapsed}
          onChange={(value) => update({ directoryWidth: value }, false)}
          onCommit={(value) => update({ directoryWidth: value })}
        />
        <div className="api-workbench-pane">
          {workbench(renderPanels, () => setMobilePanel('response'))}
        </div>
      </div>
    </section>
  )
}

type ResizeProps = {
  label: string
  value: number
  min: number
  max: number
  axis: 'x' | 'y'
  unit: 'pixel' | 'percent'
  disabled: boolean
  onChange: (value: number) => void
  onCommit: (value: number) => void
}
function ResizeHandle({
  label,
  value,
  min,
  max,
  axis,
  unit,
  disabled,
  onChange,
  onCommit,
}: ResizeProps) {
  const drag = useRef<{ position: number; value: number; length: number } | null>(null)
  function pointerValue(event: PointerEvent<HTMLDivElement>) {
    if (!drag.current) return null
    const delta = (axis === 'x' ? event.clientX : event.clientY) - drag.current.position
    return bounded(
      drag.current.value + delta * (unit === 'percent' ? 100 / drag.current.length : 1),
      value,
      min,
      max,
    )
  }
  return (
    <div
      className={`api-resize-handle axis-${axis}`}
      role="separator"
      aria-label={label}
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      onPointerDown={(event) => {
        if (disabled || event.button !== 0) return
        const rect = event.currentTarget.parentElement?.getBoundingClientRect()
        drag.current = {
          position: axis === 'x' ? event.clientX : event.clientY,
          value,
          length: Math.max(1, (axis === 'x' ? rect?.width : rect?.height) ?? 1),
        }
        event.currentTarget.setPointerCapture(event.pointerId)
        event.preventDefault()
      }}
      onPointerMove={(event) => {
        const next = pointerValue(event)
        if (next !== null) onChange(next)
      }}
      onPointerUp={(event) => {
        const next = pointerValue(event)
        drag.current = null
        if (next !== null) onCommit(next)
      }}
      onPointerCancel={() => {
        if (drag.current) onChange(drag.current.value)
        drag.current = null
      }}
      onKeyDown={(event) => {
        if (disabled) return
        const next = keyboardSize(event.key, axis, value, min, max, unit === 'pixel' ? 16 : 2)
        if (next === null) return
        event.preventDefault()
        onCommit(next)
      }}
    />
  )
}
function keyboardSize(
  key: string,
  axis: 'x' | 'y',
  value: number,
  min: number,
  max: number,
  step: number,
): number | null {
  if (key === 'Home') return min
  if (key === 'End') return max
  if (key === (axis === 'x' ? 'ArrowLeft' : 'ArrowUp')) return Math.max(min, value - step)
  if (key === (axis === 'x' ? 'ArrowRight' : 'ArrowDown')) return Math.min(max, value + step)
  return null
}
