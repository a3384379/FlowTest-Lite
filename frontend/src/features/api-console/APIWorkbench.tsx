import { useDraftSession } from '../drafts/draft-session'
import { EyeOutlined, SaveOutlined } from '@ant-design/icons'
import {
  Button,
  Alert,
  Checkbox,
  Empty,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Tabs,
} from 'antd'
import { useEffect, useRef, useState, type ReactNode } from 'react'

import BodyEditor from './BodyEditor'
import AuthConfigurationFields from './AuthConfigurationFields'
import { validateAuthConfiguration } from './auth-configuration'
import { toBodyFields, toBodyInput, type BodyEditorFields } from './body-edit'
import {
  parseBulkHeaders,
  parseBulkParameters,
  serializeBulkHeaders,
  serializeBulkParameters,
  type BulkRedactionMode,
  type KeyValueField,
  type ParameterField,
} from './bulk-edit'
import { BulkEditor, DynamicFields } from './StructuredFields'
import type { ApiVersionInput } from './api-service'
import { apiErrorMessage, type ApiDetail, type ApiVersion, type Artifact } from '../../lib/api'

type APIWorkbenchProps = {
  editable?: boolean
  detail?: ApiDetail
  loading: boolean
  saving: boolean
  previewing: boolean
  onSave: (input: ApiVersionInput) => Promise<ApiVersion>
  onPreview: () => Promise<unknown>
  artifacts?: Artifact[]
  requestActions?: ReactNode
  actions?: ReactNode
  response: ReactNode
  renderPanels: (request: ReactNode, response: ReactNode) => ReactNode
}

export type WorkbenchFields = BodyEditorFields & {
  method: ApiVersion['method']
  path: string
  query_parameters: Array<KeyValueField & { enabled: boolean }>
  headers: KeyValueField[]
  variables: KeyValueField[]
  auth_kind: ApiVersion['auth_kind']
  auth_config: KeyValueField[]
  extraction_rules: ApiVersion['extraction_rules']
  assertions: Array<Omit<ApiVersion['assertions'][number], 'expected'> & { expected_text: string }>
}

export default function APIWorkbench(props: APIWorkbenchProps) {
  if (!props.detail) {
    return props.renderPanels(
      <section className="api-panel api-request-panel">
        <header className="pane-heading"><h2>请求配置</h2></header>
        <Empty className="workspace-empty" image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={props.loading ? '正在读取接口' : '从目录选择或新建接口'} />
      </section>,
      props.response,
    )
  }
  return <LoadedAPIWorkbench {...props} detail={props.detail} />
}

function LoadedAPIWorkbench(props: APIWorkbenchProps & { detail: ApiDetail }) {
  const [form] = Form.useForm<WorkbenchFields>()
  const [preview, setPreview] = useState<unknown>(null)
  const draft = useApiDraft(form, props)
  const redactionMode = 'off'
  const requestTabs = [
    { key: 'params', label: '参数', children: <ParameterFields onProgrammaticChange={draft.persistCurrent} /> },
    { key: 'headers', label: '请求头', children: <HeaderFields redactionMode={redactionMode} onProgrammaticChange={draft.persistCurrent} /> },
    { key: 'variables', label: '变量', children: <KeyValueFields name="variables" redactionMode={redactionMode} /> },
    { key: 'auth', label: '认证', children: <AuthFields redactionMode={redactionMode} /> },
    { key: 'body', label: '请求体', children: <BodyEditor artifacts={props.artifacts ?? []} onProgrammaticChange={draft.persistCurrent} /> },
    { key: 'extract', label: '提取', children: <ExtractionFields /> },
    { key: 'assertions', label: '断言', children: <AssertionFields /> },
  ]
  return (
    <>
      <Form className="api-workbench-form" form={form} layout="vertical" disabled={props.editable === false}
        onValuesChange={draft.onValuesChange} onFinish={draft.onFinish}>
        <div className="api-request-strip">
          <div className="api-request-identity">
            <h2>{props.detail.definition.name}</h2>
            {draft.dirty && <span className="workbench-state" data-dirty>未保存 · 发送使用已保存配置</span>}
            <Space size={4} className="request-tools">
              <Button type="text" size="small" icon={<EyeOutlined />} loading={props.previewing}
                onClick={() => void props.onPreview().then(setPreview).catch(() => undefined)}>预览</Button>
              {props.actions}
            </Space>
          </div>
          <div className="workbench-request-line">
            <Form.Item name="method" rules={[{ required: true }]}>
              <Select aria-label="HTTP 方法" className="method-select"
                options={['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE'].map((value) => ({ value }))} />
            </Form.Item>
            <Form.Item name="path" rules={[{ required: true, message: '请输入请求路径' }]}>
              <Input aria-label="请求路径" placeholder="/api/orders/{{order_id}}" />
            </Form.Item>
            {props.requestActions}
            <Button icon={<SaveOutlined />} loading={props.saving} htmlType="submit">保存接口</Button>
          </div>
          {draft.error && <Alert type="error" showIcon title={draft.error} />}
        </div>
        {props.renderPanels(
          <section className="api-panel api-request-panel" aria-label="请求配置">
            <header className="pane-heading"><h2>请求配置</h2></header>
            <Tabs className="workbench-request-tabs" size="small" tabBarGutter={16}
              items={requestTabs.map((tab) => ({ ...tab, forceRender: true }))} />
          </section>,
          props.response,
        )}
      </Form>
      <Modal title="最终请求预览" open={preview !== null} footer={null} onCancel={() => setPreview(null)} width={760}>
        <pre className="preview-code">{JSON.stringify(preview, null, 2)}</pre>
      </Modal>
    </>
  )
}

function useApiDraft(
  form: ReturnType<typeof Form.useForm<WorkbenchFields>>[0],
  props: APIWorkbenchProps & { detail: ApiDetail },
) {
  const session = useDraftSession()
  const id = props.detail.definition.id
  const loaded = useRef(false)
  const [dirty, setDirty] = useState(() => session.apis.has(id))
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (loaded.current) return
    loaded.current = true
    form.setFieldsValue(session.apis.get(id)?.fields ?? toFields(props.detail.version))
  }, [form, id, props.detail.version, session])
  function persist(values: WorkbenchFields) {
    const baseVersion = session.apis.get(id)?.baseVersion ?? props.detail.version.version
    session.apis.set(id, {
      fields: structuredClone(values),
      generation: session.nextGeneration(),
      baseVersion,
    })
    session.markUnsafe(id, true)
    setDirty(true)
  }
  return {
    error,
    dirty,
    onValuesChange: (_: unknown, values: WorkbenchFields) => persist(values),
    persistCurrent: () => persist(form.getFieldsValue(true)),
    onFinish: async (values: WorkbenchFields) => {
      const startingDraft = session.apis.get(id)
      try {
        const saved = await props.onSave({
          ...toInput(values),
          base_version: startingDraft?.baseVersion ?? props.detail.version.version,
        })
        const latest = session.apis.get(id)
        if (latest && latest.generation !== startingDraft?.generation) {
          session.apis.set(id, { ...latest, baseVersion: saved.version })
        } else {
          session.apis.delete(id)
          session.markUnsafe(id, false)
          setDirty(false)
        }
        setError(null)
      } catch (cause) {
        setError(apiErrorMessage(cause))
      }
    },
  }
}


function ParameterFields({ onProgrammaticChange }: { onProgrammaticChange: () => void }) {
  const form = Form.useFormInstance<WorkbenchFields>()
  const [bulkText, setBulkText] = useState<string | null>(null)
  const [bulkErrors, setBulkErrors] = useState<string[]>([])
  if (bulkText !== null) {
    return (
      <BulkEditor
        label="Params"
        text={bulkText}
        errors={bulkErrors}
        help="每行使用“参数名: 值”；# 开头表示禁用，同名参数会按顺序保留。"
        onChange={setBulkText}
        onCancel={() => {
          setBulkText(null)
          setBulkErrors([])
        }}
        onApply={() => {
          const parsed = parseBulkParameters(bulkText)
          setBulkErrors(parsed.errors)
          if (parsed.errors.length) return
          form.setFieldValue('query_parameters', parsed.values)
          onProgrammaticChange()
          setBulkText(null)
        }}
      />
    )
  }
  return (
    <Form.List name="query_parameters">
      {(fields, { add, remove }) => (
        <DynamicFields
          fields={fields}
          onAdd={() => add({ enabled: true, name: '', value: '' })}
          onRemove={remove}
          onBulkEdit={() => {
            const parameters = (form.getFieldValue('query_parameters') ?? []) as ParameterField[]
            setBulkText(serializeBulkParameters(parameters))
            setBulkErrors([])
          }}
          render={(field) => (
            <>
              <Form.Item name={[field.name, 'enabled']} valuePropName="checked">
                <Checkbox aria-label="启用参数" />
              </Form.Item>
              <Form.Item name={[field.name, 'name']} rules={[{ required: true }]}>
                <Input placeholder="参数名" />
              </Form.Item>
              <Form.Item name={[field.name, 'value']}>
                <Input placeholder="值或 {{变量}}" />
              </Form.Item>
            </>
          )}
        />
      )}
    </Form.List>
  )
}

function HeaderFields({
  redactionMode,
  onProgrammaticChange,
}: {
  redactionMode: BulkRedactionMode
  onProgrammaticChange: () => void
}) {
  const form = Form.useFormInstance<WorkbenchFields>()
  const [bulkText, setBulkText] = useState<string | null>(null)
  const [bulkErrors, setBulkErrors] = useState<string[]>([])
  const [originalHeaders, setOriginalHeaders] = useState<KeyValueField[]>([])
  if (bulkText !== null) {
    return (
      <BulkEditor
        label="Headers"
        text={bulkText}
        errors={bulkErrors}
        help={
          redactionMode === 'on'
            ? '每行使用“Header 名: 值”；# 开头的注释行不会保存，敏感值请使用 {{secret.NAME}}。'
            : '每行使用“Header 名: 值”；# 开头的注释行不会保存，当前项目脱敏已关闭，输入值会按原样保留。'
        }
        onChange={setBulkText}
        onCancel={() => {
          setBulkText(null)
          setBulkErrors([])
        }}
        onApply={() => {
          const parsed = parseBulkHeaders(bulkText, originalHeaders, redactionMode)
          setBulkErrors(parsed.errors)
          if (parsed.errors.length) return
          form.setFieldValue('headers', parsed.values)
          onProgrammaticChange()
          setBulkText(null)
        }}
      />
    )
  }
  return (
    <Form.List
      name="headers"
      rules={[
        {
          validator: async (_, values: KeyValueField[] = []) => {
            const names = values.map((item) => item?.name?.trim().toLowerCase()).filter(Boolean)
            if (new Set(names).size !== names.length)
              throw new Error('Header 名称不能重复（不区分大小写）')
          },
        },
      ]}
    >
      {(fields, { add, remove }, { errors }) => (
        <>
          <Form.ErrorList errors={errors} />
          <DynamicFields
            fields={fields}
            onAdd={() => add({ name: '', value: '' })}
            onRemove={remove}
            onBulkEdit={() => {
              const headers = (form.getFieldValue('headers') ?? []) as KeyValueField[]
              setOriginalHeaders(headers)
              setBulkText(serializeBulkHeaders(headers, redactionMode))
              setBulkErrors([])
            }}
            render={(field) => (
              <>
                <Form.Item name={[field.name, 'name']} rules={[{ required: true }]}>
                  <Input placeholder="名称" />
                </Form.Item>
                <Form.Item name={[field.name, 'value']}>
                  <Input
                    type={redactionMode === 'on' ? 'password' : 'text'}
                    placeholder="值或 {{secret.NAME}}"
                  />
                </Form.Item>
              </>
            )}
          />
        </>
      )}
    </Form.List>
  )
}

function KeyValueFields({
  name,
  redactionMode,
}: {
  name: 'auth_config' | 'variables'
  redactionMode: BulkRedactionMode
}) {
  return (
    <Form.List name={name}>
      {(fields, { add, remove }) => (
        <DynamicFields
          fields={fields}
          onAdd={() => add({ name: '', value: '' })}
          onRemove={remove}
          render={(field) => (
            <>
              <Form.Item name={[field.name, 'name']} rules={[{ required: true }]}>
                <Input placeholder="名称" />
              </Form.Item>
              <Form.Item name={[field.name, 'value']}>
                <Input
                  type={redactionMode === 'on' ? 'password' : 'text'}
                  placeholder="值或 {{secret.NAME}}"
                />
              </Form.Item>
            </>
          )}
        />
      )}
    </Form.List>
  )
}

function AuthFields({ redactionMode }: { redactionMode: BulkRedactionMode }) {
  const form = Form.useFormInstance<WorkbenchFields>()
  const kind = Form.useWatch('auth_kind', form) ?? 'none'
  return (
    <>
      <Form.Item name="auth_kind" label="认证方式">
        <Select
          options={[
            { value: 'none', label: '无认证' },
            { value: 'bearer', label: 'Bearer Token' },
            { value: 'basic', label: 'Basic Auth' },
            { value: 'api_key', label: 'API Key' },
          ]}
        />
      </Form.Item>
      <Form.Item
        name="auth_config"
        rules={[
          {
            validator: (_, values: KeyValueField[]) => {
              try {
                validateAuthConfiguration(kind, values ?? [])
                return Promise.resolve()
              } catch (error) {
                return Promise.reject(error)
              }
            },
          },
        ]}
      >
        <AuthConfigurationFields kind={kind} redactionMode={redactionMode} />
      </Form.Item>
    </>
  )
}

function ExtractionFields() {
  return (
    <Form.List name="extraction_rules">
      {(fields, { add, remove }) => (
        <DynamicFields
          fields={fields}
          onAdd={() => add({ name: '', kind: 'jsonpath', expression: '' })}
          onRemove={remove}
          render={(field) => (
            <>
              <Form.Item name={[field.name, 'name']} rules={[{ required: true }]}>
                <Input placeholder="变量名" />
              </Form.Item>
              <Form.Item name={[field.name, 'kind']}>
                <Select
                  className="role-select"
                  options={['jsonpath', 'jmespath', 'header'].map((value) => ({
                    value,
                    label: value,
                  }))}
                />
              </Form.Item>
              <Form.Item name={[field.name, 'expression']} rules={[{ required: true }]}>
                <Input placeholder="$.data.token" />
              </Form.Item>
            </>
          )}
        />
      )}
    </Form.List>
  )
}

function AssertionFields() {
  return (
    <Form.List name="assertions">
      {(fields, { add, remove }) => (
        <DynamicFields
          fields={fields}
          onAdd={() =>
            add({ kind: 'status_code', operator: 'equals', target: null, expected_text: '200' })
          }
          onRemove={remove}
          render={(field) => (
            <>
              <Form.Item name={[field.name, 'kind']}>
                <Select
                  className="assertion-select"
                  options={[
                    'status_code',
                    'response_time',
                    'header',
                    'jsonpath',
                    'jmespath',
                    'json_schema', 'file_size', 'file_sha256', 'content_type',
                  ].map((value) => ({ value, label: value }))}
                />
              </Form.Item>
              <Form.Item name={[field.name, 'operator']}>
                <Select
                  className="assertion-select"
                  options={[
                    'equals',
                    'not_equals',
                    'contains',
                    'exists',
                    'less_than',
                    'greater_than', 'less_than_or_equal', 'greater_than_or_equal', 'matches',
                  ].map((value) => ({ value, label: value }))}
                />
              </Form.Item>
              <Form.Item name={[field.name, 'target']}>
                <Input placeholder="目标（可选）" />
              </Form.Item>
              <Form.Item name={[field.name, 'expected_text']}>
                <Input placeholder="预期值（JSON 或文本）" />
              </Form.Item>
            </>
          )}
        />
      )}
    </Form.List>
  )
}

function toFields(version: ApiVersion): WorkbenchFields {
  return {
    method: version.method,
    path: version.path,
    query_parameters: version.query_parameters,
    headers: toKeyValues(version.headers),
    variables: toKeyValues(version.variables ?? {}),
    ...toBodyFields(version),
    auth_kind: version.auth_kind,
    auth_config: toKeyValues(version.auth_config),
    extraction_rules: version.extraction_rules,
    assertions: version.assertions.map((assertion) => ({
      kind: assertion.kind,
      operator: assertion.operator,
      target: assertion.target,
      expected_text: JSON.stringify(assertion.expected),
    })),
  }
}

function toInput(values: WorkbenchFields): Omit<ApiVersionInput, 'base_version'> {
  validateAuthConfiguration(values.auth_kind, values.auth_config ?? [])
  const body = toBodyInput(values)
  return {
    method: values.method,
    path: values.path,
    query_parameters: values.query_parameters ?? [],
    headers: toRecord(values.headers),
    variables: toRecord(values.variables),
    ...body,
    auth_kind: values.auth_kind,
    auth_config: toRecord(values.auth_config),
    extraction_rules: values.extraction_rules ?? [],
    assertions: (values.assertions ?? []).map((assertion) => ({
      kind: assertion.kind,
      operator: assertion.operator,
      target: assertion.target || null,
      expected: parseExpected(assertion.expected_text),
    })),
  }
}

function toKeyValues(value: Record<string, string>): KeyValueField[] {
  return Object.entries(value).map(([name, fieldValue]) => ({ name, value: fieldValue }))
}

function toRecord(values: KeyValueField[] = []): Record<string, string> {
  return Object.fromEntries(
    values.filter((item) => item.name).map((item) => [item.name, item.value]),
  )
}

function parseExpected(value: string): unknown {
  if (!value?.trim()) return null
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}
