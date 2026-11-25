import { useEffect, useState } from 'react'
import { Alert, App, Button, Drawer, Form, Input, Popconfirm, Select, Space, Spin } from 'antd'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import EnvironmentMapEditor from '../features/api-console/EnvironmentMapEditor'
import { mapValue, parseEnvironmentMap, type EnvironmentMapValue } from '../features/api-console/environment-map'
import {
  apiErrorMessage, client, createAsset, deleteAsset, listAssets, updateAsset,
  type CommonSettings, type Environment,
} from '../lib/api'

export type EnvironmentSelection = { environment?: string; selectEnvironment: (id?: string) => void }

type Fields = { name?: string; base_url?: string; variables: EnvironmentMapValue; headers: EnvironmentMapValue }

export default function EnvironmentToolbar({ environment, selectEnvironment }: EnvironmentSelection) {
  const [open, setOpen] = useState(false)
  const catalog = useQuery({ queryKey: ['environments'], queryFn: () => listAssets('environment') })
  const available = catalog.data
  const validSelection = available?.some((item) => item.id === environment)
  useEffect(() => {
    if (available && environment && !validSelection) selectEnvironment(undefined)
  }, [available, environment, validSelection, selectEnvironment])
  return (
    <Space wrap>
      <Select
        aria-label="执行环境"
        style={{ minWidth: 150 }}
        value={validSelection ? environment : undefined}
        loading={catalog.isPending}
        placeholder="默认地址"
        allowClear
        onChange={selectEnvironment}
        options={available?.map((item) => ({ value: item.id, label: item.name }))}
      />
      <Button onClick={() => setOpen(true)}>环境与公共参数</Button>
      <Drawer title="环境与公共参数" size={550} open={open} onClose={() => setOpen(false)} destroyOnHidden>
        {catalog.error ? <Alert type="error" title={apiErrorMessage(catalog.error)} /> : (
          <EnvironmentEditor environments={available ?? []} onSelect={selectEnvironment} />
        )}
      </Drawer>
    </Space>
  )
}

function EnvironmentEditor({ environments, onSelect }: { environments: Environment[]; onSelect: (id?: string) => void }) {
  const [key, setKey] = useState('common')
  const common = useQuery({
    queryKey: ['settings'],
    queryFn: () => client.get<CommonSettings>('/settings').then((res) => res.data),
  })
  if (common.isPending) return <Spin />
  if (common.isError) return <Alert type="error" title={apiErrorMessage(common.error)} />
  const current = environments.find((item) => item.id === key)
  return (
    <Space orientation="vertical" size="middle" className="full-width">
      <Select
        aria-label="要配置的环境"
        className="full-width"
        value={key}
        onChange={setKey}
        options={[
          { value: 'common', label: '公共参数' },
          ...environments.map((item) => ({ value: item.id, label: item.name })),
          { value: 'new', label: '新建环境' },
        ]}
      />
      <SettingsForm
        key={key}
        isCommon={key === 'common'}
        values={key === 'common' ? common.data : current}
        current={current}
        onCreated={(id) => { setKey(id); onSelect(id) }}
        onDeleted={() => setKey('common')}
      />
    </Space>
  )
}

function SettingsForm({ isCommon, values, current, onCreated, onDeleted }: {
  isCommon: boolean
  values?: CommonSettings
  current?: Environment
  onCreated: (id: string) => void
  onDeleted: () => void
}) {
  const cache = useQueryClient()
  const { message } = App.useApp()
  const [saving, setSaving] = useState(false)
  async function save(fields: Fields) {
    setSaving(true)
    try {
      const next = {
        base_url: fields.base_url?.trim() ?? '',
        variables: parseEnvironmentMap(fields.variables, 'variables'),
        headers: parseEnvironmentMap(fields.headers, 'headers'),
      }
      if (isCommon) {
        await client.put('/settings', next)
        await cache.invalidateQueries({ queryKey: ['settings'] })
      } else {
        const input = { ...next, name: fields.name?.trim() ?? '' }
        const result = current
          ? await updateAsset('environment', current.id, current.revision, input)
          : await createAsset('environment', input)
        await cache.invalidateQueries({ queryKey: ['environments'] })
        if (!current) onCreated(result.id)
      }
      message.success('已保存设置')
    } catch (error) {
      message.error(apiErrorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    if (!current) return
    try {
      await deleteAsset('environment', current.id)
      await cache.invalidateQueries({ queryKey: ['environments'] })
      onDeleted()
    } catch (error) {
      message.error(apiErrorMessage(error))
    }
  }

  return (
    <Form<Fields>
      layout="vertical"
      initialValues={{
        name: current?.name, base_url: values?.base_url,
        variables: mapValue(values?.variables ?? {}), headers: mapValue(values?.headers ?? {}),
      }}
      onFinish={(fields) => void save(fields)}
    >
      {!isCommon && <Form.Item name="name" label="环境名称" rules={[{ required: true }]}><Input /></Form.Item>}
      <Form.Item name="base_url" label="基础地址"><Input placeholder="https://api.example.test" /></Form.Item>
      <Form.Item name="variables" label="变量"><EnvironmentMapEditor kind="variables" readOnly={false} /></Form.Item>
      <Form.Item name="headers" label="公共请求头"><EnvironmentMapEditor kind="headers" readOnly={false} /></Form.Item>
      <Space>
        <Button type="primary" htmlType="submit" loading={saving}>保存设置</Button>
        {current && <Popconfirm title="删除这个环境？" onConfirm={remove}><Button danger>删除环境</Button></Popconfirm>}
      </Space>
    </Form>
  )
}
