import type { NodeExecution, RequestSnapshot, ResponseSnapshot } from '../lib/api'

export const states: Record<string, string> = {
  running: '运行中', passed: '通过', failed: '失败', cancelled: '已取消', skipped: '已跳过', error: '错误',
}

export function Status({ value }: { value: string }) {
  return <span className="status" data-state={value}>{states[value] ?? value}</span>
}

function jsonText(value: unknown) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '—'
}

export function JsonPanel({ title, value, open = false }: { title: string; value: unknown; open?: boolean }) {
  const text = value == null ? '（空）' : jsonText(value)
  return <details className="json-panel" open={open}>
    <summary>{title}</summary>
    <pre>{text.length > 32_000 ? text.slice(0, 32_000) + '\n… 完整内容请查看浏览器工作台。' : text}</pre>
  </details>
}

type Check = { name: string; passed: boolean; expected: unknown; actual: unknown; message: string }

export function Checks({ checks }: { checks: readonly Check[] }) {
  if (!checks.length) return null
  return <section className="checks" aria-label="断言结果">
    <h4>断言结果</h4>
    {checks.map((check, index) => <article key={index} className="check">
      <div className="spread"><strong>{check.name}</strong><Status value={check.passed ? 'passed' : 'failed'} /></div>
      <p>{check.message}</p>
      <dl><dt>预期值</dt><dd>{jsonText(check.expected)}</dd><dt>实际值</dt><dd>{jsonText(check.actual)}</dd></dl>
    </article>)}
  </section>
}

export function RequestEvidence({ request }: { request: RequestSnapshot }) {
  return <>
    <p className="endpoint"><strong>{request.method}</strong> <code>{request.url}</code></p>
    <JsonPanel title="请求头" value={request.headers} />
    {request.body != null && <JsonPanel title="请求体" value={request.body} />}
  </>
}

export function ResponseEvidence({ response }: { response: ResponseSnapshot }) {
  return <>
    <div className="response-summary">
      <strong>HTTP {response.status_code}</strong>
      {response.duration_ms !== undefined && <span>{response.duration_ms} 毫秒</span>}
      <span>{response.size_bytes.toLocaleString()} 字节</span>
    </div>
    <JsonPanel title="响应体" value={response.body} open />
    <JsonPanel title="响应头" value={response.headers} />
  </>
}

export function NodeEvidence({ node }: { node: NodeExecution }) {
  const result = node.result
  const attempt = result?.observations.at(-1)
  const output = result?.output
  const checks = result?.assertions ?? []
  const comparison = !checks.length && output && typeof output === 'object' && 'actual' in output && 'expected' in output
    ? [{ name: node.name, passed: node.status === 'passed', actual: output.actual, expected: output.expected, message: '' }]
    : checks
  return <>
    <div className="spread"><h4>{node.name}</h4><Status value={node.status} /></div>
    {node.error_message && <p className="error" role="alert">{node.error_message}</p>}
    {attempt && <>
      {result && result.observations.length > 1 && <p className="muted">第 {attempt.attempt} 次请求</p>}
      <RequestEvidence request={attempt.request} />
      {attempt.response && <ResponseEvidence response={{ ...attempt.response, duration_ms: attempt.duration_ms }} />}
      {attempt.mappings.length > 0 && <JsonPanel title="参数映射" value={attempt.mappings} />}
    </>}
    <Checks checks={comparison} />
    {output != null && <JsonPanel title="节点输出" value={output} />}
  </>
}
