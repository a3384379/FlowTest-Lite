import { Alert, Descriptions, Empty, Space, Table, Tag, Tabs, Typography } from 'antd'
import ResponseCodeReader from '../features/api-console/ResponseCodeReader'
import type { InterfaceRun, NodeExecution, Observation } from '../lib/api'

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

export function InterfaceResult({ result }: { result?: InterfaceRun }) {
  if (!result) return <Empty description="发送请求后查看响应" />
  const { execution, response, request } = result
  return (
    <>
      <Space wrap>
        <Status status={execution.status} />
        {response && <Typography.Text strong>HTTP {response.status_code}</Typography.Text>}
        <Typography.Text>{execution.elapsed_ms} ms</Typography.Text>
        {response && <Typography.Text type="secondary">{response.size_bytes} 字节</Typography.Text>}
      </Space>
      {execution.error_message && <Alert showIcon type="error" title={execution.error_message} />}
      <Tabs
        key={execution.id}
        items={[
          { key: 'body', label: '响应体', children: <ResponseCodeReader title="响应体" value={response?.body ?? null} /> },
          { key: 'headers', label: '响应头', children: <ResponseCodeReader title="响应头" value={response?.headers ?? null} /> },
          { key: 'request', label: '实际请求', children: <ResponseCodeReader title="实际请求" value={request} /> },
          { key: 'assertions', label: `断言（${result.assertions.length}）`, children: <Assertions checks={
            result.assertions.map((item) => ({ ...item, name: [item.kind, item.target, item.operator].filter(Boolean).join(' ') }))
          } /> },
          { key: 'extracted', label: '提取结果', children: <ResponseCodeReader title="提取结果" value={result.extracted} /> },
        ]}
      />
    </>
  )
}

export function NodeResultView({ item }: { item: NodeExecution }) {
  const result = item.result
  const output = result?.output
  const comparison = typeof output === 'object' && output !== null && 'expected' in output && 'actual' in output
    ? { expected: output.expected, actual: output.actual }
    : null
  return (
    <Space orientation="vertical" className="full-width">
      <Space wrap><Status status={item.status} /><Typography.Text>{item.name}</Typography.Text></Space>
      {item.error_message && <Alert showIcon type="error" title={item.error_message} description={item.error_code} />}
      {Boolean(result?.assertions.length) && <Assertions checks={result!.assertions} />}
      {comparison && (
        <Descriptions size="small" column={1} items={[
          { key: 'expected', label: '预期值', children: <CodeValue value={comparison.expected} /> },
          { key: 'actual', label: '实际值', children: <CodeValue value={comparison.actual} /> },
        ]} />
      )}
      {result?.observations.length ? (
        <Tabs items={result.observations.map((attempt, index) => ({
          key: String(index), label: `请求 ${attempt.attempt} · ${attempt.response?.status_code ?? '错误'}`,
          children: <AttemptEvidence attempt={attempt} />,
        }))} />
      ) : null}
      {output != null && <ResponseCodeReader title="节点输出" value={output} />}
    </Space>
  )
}

function AttemptEvidence({ attempt }: { attempt: Observation }) {
  return (
    <Space orientation="vertical" className="full-width">
      <Typography.Text>{attempt.duration_ms} ms</Typography.Text>
      {attempt.error_message && <Alert type="error" title={attempt.error_message} />}
      <ResponseCodeReader title="实际请求" value={attempt.request} />
      {Boolean(attempt.mappings.length) && <ResponseCodeReader title="映射参数" value={attempt.mappings} />}
      {attempt.response && <ResponseCodeReader title="响应" value={attempt.response} />}
    </Space>
  )
}
