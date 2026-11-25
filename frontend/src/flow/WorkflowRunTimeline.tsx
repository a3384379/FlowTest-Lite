import { Button, Checkbox, Empty, Tag } from 'antd'
import { useState } from 'react'
import { Status } from '../components/RunEvidence'
import type { FlowRun, NodeExecution } from '../lib/api'

export function orderedSteps(nodes: NodeExecution[]): NodeExecution[] {
  return nodes.toSorted((left, right) => {
    if (!left.started_at && right.started_at) return 1
    if (left.started_at && !right.started_at) return -1
    return (left.started_at ?? left.occurred_at).localeCompare(right.started_at ?? right.occurred_at)
  })
}

function durationOf(node: NodeExecution) {
  if (!node.started_at || node.status === 'running') return '—'
  const duration = new Date(node.occurred_at).valueOf() - new Date(node.started_at).valueOf()
  return `${Math.max(0, duration)} ms`
}

export default function WorkflowRunTimeline({ run, selected, onSelect }: {
  run: FlowRun; selected?: string; onSelect: (nodeId: string) => void
}) {
  const [onlyFailed, setOnlyFailed] = useState(false)
  const all = orderedSteps(run.nodes)
  const rows = onlyFailed ? all.filter((node) => ['failed', 'cancelled'].includes(node.status)) : all
  const complete = all.filter((node) => node.status !== 'pending' && node.status !== 'running').length
  const failed = all.filter((node) => node.status === 'failed').length
  return (
    <section className="workflow-timeline" aria-label="执行时间线">
      <header className="pane-heading">
        <h2>执行时间线</h2>
        <Tag>{complete} / {all.length}</Tag><Status status={run.status} />
        {failed > 0 && <Tag color="red">{failed} 失败</Tag>}
        <Checkbox className="timeline-filter" checked={onlyFailed} onChange={(event) => setOnlyFailed(event.target.checked)}>仅失败或取消</Checkbox>
      </header>
      {rows.length ? <div className="timeline-scroll">
        <table>
          <thead><tr><th>步骤</th><th>状态</th><th>耗时</th><th>结果</th></tr></thead>
          <tbody>
            {rows.map((node) => (
              <tr key={node.node_id} data-selected={node.node_id === selected} data-status={node.status}>
                <td><Button type="link" size="small" onClick={() => onSelect(node.node_id)}>{node.name}</Button></td>
                <td><Status status={node.status} /></td>
                <td>{durationOf(node)}</td>
                <td>{node.error_message ?? (node.result?.observations.at(-1)?.response?.status_code
                  ? `HTTP ${node.result.observations.at(-1)?.response?.status_code}` : '—')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={onlyFailed ? '没有失败或取消的步骤' : '等待流程运行'} />}
    </section>
  )
}
