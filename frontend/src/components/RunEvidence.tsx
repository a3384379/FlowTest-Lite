import { Alert, Button, Descriptions, Empty, Space, Spin, Table, Tag, Tabs, Typography } from 'antd'
import { useEffect, useState } from 'react'
import ResponseCodeReader from '../features/api-console/ResponseCodeReader'
import type { ApiAssertion, InterfaceRun, NodeExecution, Observation } from '../lib/api'

export const statusLabel: Record<string, string> = {
  pending: '等待', running: '运行中', passed: '通过', failed: '失败',
  skipped: '已跳过', cancelled: '已取消', error: '错误',
}

export function Status({ status }: { status: string }) {
  const colors: Record<string, string> = { passed: 'green', failed: 'red', running: 'blue', error: 'red' }
  return <Tag color={colors[status]}>{statusLabel[status] ?? status}</Tag>
}

type Evidence = { name: string; passed: boolean; expected: unknown; actual: unknown; message: string }

function Assertions({ checks }: { checks: Evidence[] }) {
  if (!checks.length) return <Empty description="没有断言结果" />
  return (
    <Table<Evidence>
      pagination={false}
      size="small"
      dataSource={checks.map((item, index) => ({ ...item, key: index }))}
      columns={[
        { title: '断言', render: (_, item) => <><strong>{item.name}</strong><br />{item.message}</> },
        { title: '预期值', render: (_, item) => <CodeValue value={item.expected} /> },
        { title: '实际值', render: (_, item) => <CodeValue value={item.actual} /> },
        { title: '结果', render: (_, item) => <Status status={item.passed ? 'passed' : 'failed'} /> },
      ]}
    />
  )
}

function CodeValue({ value }: { value: unknown }) {
  return <code className="evidence-value">{JSON.stringify(value) ?? '—'}</code>
}

export function InterfaceResult({ history, configured, sending }: {
  history: InterfaceRun[]; configured: ApiAssertion[]; sending: boolean
}) {
  const [focus, setFocus] = useState<string>()
  const [tab, setTab] = useState('body')
  const latest = history[0]?.execution.id
  useEffect(() => { setFocus(undefined) }, [latest])
  const result = history.find((entry) => entry.execution.id === focus) ?? history[0]
  const execution = result?.execution
  const response = result?.response
  const checks = result?.assertions ?? []
  return (
    <section className="api-panel api-response-panel" aria-label="响应与验证" data-complete={Boolean(result)}>
      <header className="pane-heading">
        <h2>响应</h2>
        {sending ? <Space size={6}><Spin size="small" />发送中</Space> : response && (
          <Space size={8} wrap className="response-summary">
            <Tag color={response.status_code < 400 ? 'green' : 'red'}>HTTP {response.status_code}</Tag>
            <span>{execution?.elapsed_ms} ms</span>
            <span>{response.size_bytes.toLocaleString()} B</span>
          </Space>
        )}
      </header>
      {(checks.length > 0 || configured.length > 0) && (
        <div className="response-check-summary">
          {checks.length
            ? <Status status={checks.every((check) => check.passed) ? 'passed' : 'failed'} />
            : <span>已保存断言</span>}
          <span>{checks.length ? `${checks.filter((check) => check.passed).length} / ${checks.length} 条断言通过` : `${configured.length} 条`}</span>
          <Button type="link" size="small" onClick={() => setTab('assertions')}>查看断言</Button>
        </div>
      )}
      {execution?.error_message && <Alert showIcon type="error" title={execution.error_message} />}
      <Tabs className="workbench-response-tabs" size="small" activeKey={tab} onChange={setTab}
        items={[
          { key: 'body', label: '响应体', children: response
            ? <ResponseCodeReader title="响应体" value={response.body} />
            : <Empty className="workspace-empty" image={Empty.PRESENTED_IMAGE_SIMPLE} description={sending ? '正在等待响应' : '发送请求后查看响应'} /> },
          { key: 'headers', label: '响应头', children: response ? <ResponseCodeReader title="响应头" value={response.headers} /> : <Empty description="暂无响应头" /> },
          { key: 'request', label: '实际请求', children: result?.request ? <ResponseCodeReader title="实际请求" value={result.request} /> : <Empty description="暂无实际请求" /> },
          { key: 'assertions', label: '断言', children: checks.length
            ? <Assertions checks={checks.map((item) => ({ ...item, name: [item.kind, item.target, item.operator].filter(Boolean).join(' ') }))} />
            : <SavedAssertions checks={configured} /> },
          { key: 'extracted', label: '提取', children: result ? <ResponseCodeReader title="提取结果" value={result.extracted} /> : <Empty description="暂无提取结果" /> },
          { key: 'history', label: '会话记录', children: history.length ? (
            <ul className="api-history">
              {history.map((item) => (
                <li key={item.execution.id}>
                  <button type="button" aria-current={item.execution.id === execution?.id}
                    onClick={() => { setFocus(item.execution.id); setTab('body') }}>
                    <span>{new Date(item.execution.started_at).toLocaleTimeString()}</span>
                    <strong>{item.response ? `HTTP ${item.response.status_code}` : '请求出错'}</strong>
                    <span>{item.execution.elapsed_ms} ms</span><Status status={item.execution.status} />
                  </button>
                </li>
              ))}
            </ul>
          ) : <Empty description="本次会话暂无请求记录" /> },
        ]}
      />
    </section>
  )
}

function SavedAssertions({ checks }: { checks: ApiAssertion[] }) {
  if (!checks.length) return <Empty description="暂无已保存断言" />
  return (
    <ul className="saved-assertions">
      {checks.map((item, index) => (
        <li key={index}><span>{[item.kind, item.target, item.operator].filter(Boolean).join(' ')}</span><CodeValue value={item.expected} /></li>
      ))}
    </ul>
  )
}

export function NodeResultView({ item }: { item: NodeExecution }) {
  const result = item.result
  const output = result?.output
  const comparison = typeof output === 'object' && output !== null && 'expected' in output && 'actual' in output
    ? { expected: output.expected, actual: output.actual }
    : null
  const comparisonDetails = comparison && <Descriptions size="small" column={1} items={[
    { key: 'expected', label: '预期值', children: <CodeValue value={comparison.expected} /> },
    { key: 'actual', label: '实际值', children: <CodeValue value={comparison.actual} /> },
  ]} />
  const checks = result?.assertions ?? []
  const failedAssertion = item.error_code === 'WORKFLOW_ASSERTION_FAILED' && Boolean(comparison) && !checks.length
  const showAssertions = item.status === 'failed' && (checks.length > 0 || failedAssertion)
  const observations = result?.observations ?? []
  const attemptLabel = observations.length ? `请求 / 响应（${observations.length}）` : '请求 / 响应'
  return (
    <section className="node-result">
      <div className="node-result-heading"><strong>{item.name}</strong><Status status={item.status} /></div>
      {item.error_message && <Alert showIcon type="error" title={item.error_message} description={item.error_code} />}
      {!failedAssertion && comparisonDetails}
      <Tabs size="small" defaultActiveKey={showAssertions ? 'assertions' : observations.length ? 'http' : 'output'}
        items={[
          { key: 'http', label: attemptLabel, children: observations.length > 1 ? (
            <Tabs size="small" defaultActiveKey={String(observations.length - 1)} items={observations.map((attempt, index) => ({
              key: String(index), label: `第 ${attempt.attempt} 次`, children: <AttemptEvidence attempt={attempt} />,
            }))} />
          ) : observations[0] ? <AttemptEvidence attempt={observations[0]} /> : <Empty description="本节点暂无 HTTP 记录" /> },
          { key: 'assertions', label: '断言', children: failedAssertion ? comparisonDetails : <Assertions checks={checks} /> },
          { key: 'output', label: '输出', children: output == null ? <Empty description="暂无节点输出" />
            : <ResponseCodeReader title="节点输出" value={output} /> },
        ]} />
    </section>
  )
}

function AttemptEvidence({ attempt }: { attempt: Observation }) {
  return (
    <Space orientation="vertical" className="full-width" size="middle">
      <div className="attempt-summary">
        <strong>{attempt.request.method}</strong><code title={attempt.request.url}>{attempt.request.url}</code>
        {attempt.response && <Tag color={attempt.response.status_code < 400 ? 'green' : 'red'}>HTTP {attempt.response.status_code}</Tag>}
        <span>{attempt.duration_ms} ms</span>
      </div>
      {attempt.error_message && <Alert type="error" title={attempt.error_message} />}
      <Tabs size="small" items={[
        { key: 'body', label: '响应体', children: <ResponseCodeReader title="响应体" value={attempt.response?.body ?? null} /> },
        { key: 'headers', label: '响应头', children: <ResponseCodeReader title="响应头" value={attempt.response?.headers ?? null} /> },
        { key: 'request', label: '实际请求', children: <ResponseCodeReader title="实际请求" value={attempt.request} /> },
        ...(attempt.mappings.length ? [{ key: 'mapping', label: '映射参数', children: <ResponseCodeReader title="映射参数" value={attempt.mappings} /> }] : []),
      ]} />
    </Space>
  )
}
