import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { ApartmentOutlined, ApiOutlined, MoreOutlined } from '@ant-design/icons'
import { Alert, App as AntApp, Button, Dropdown, Input, Modal, Select, Spin } from 'antd'
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BrowserRouter, Navigate, NavLink, Route, Routes, useSearchParams } from 'react-router-dom'
import IceThemeProvider from './theme/IceThemeProvider'
import { applyIceAppearance } from './theme/ice-theme'
import { DraftContext, DraftSession } from './features/drafts/draft-session'
import EnvironmentToolbar from './components/EnvironmentToolbar'
import ApiPage from './pages/ApiPage'
import FlowsPage from './pages/FlowsPage'
import { apiErrorMessage, defaultProjectId, projectApi, projectCatalog, type Project } from './lib/api'
import { ProjectApiContext } from './lib/project-context'
import './styles.css'

applyIceAppearance(document.documentElement)
const newCache = () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 5_000 } } })
const queries = newCache()
const projectPreference = 'flowtest-lite:project'

function Workspace({ projectId, picker }: { projectId: string; picker: ReactNode }) {
  const environmentKey = projectId === defaultProjectId
    ? 'flowtest-lite:environment'
    : `flowtest-lite:environment:${projectId}`
  const [environment, setEnvironment] = useState<string | undefined>(() => localStorage.getItem(environmentKey) ?? undefined)
  const selectEnvironment = useCallback((value?: string) => {
    setEnvironment(value)
    if (value) localStorage.setItem(environmentKey, value)
    else localStorage.removeItem(environmentKey)
  }, [environmentKey])
  const destination = (page: string) => `/${page}?project=${projectId}`
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-identity">
          <NavLink to={destination('apis')} className="app-brand" aria-label="FlowTest Lite 首页">
            <span className="app-brand-mark" aria-hidden="true"><ApiOutlined /></span>
            <strong>FlowTest<span className="app-brand-edition"> Lite</span></strong>
          </NavLink>
          {picker}
        </div>
        <nav className="app-navigation" aria-label="主导航">
          <NavLink to={destination('apis')}><ApiOutlined /><span>接口</span></NavLink>
          <NavLink to={destination('flows')}><ApartmentOutlined /><span>流程</span></NavLink>
        </nav>
        <EnvironmentToolbar environment={environment} selectEnvironment={selectEnvironment} />
      </header>
      <main className="app-main">
        <Routes>
          <Route path="/flows" element={<FlowsPage environment={environment} />} />
          <Route path="/apis" element={<ApiPage environment={environment} />} />
          <Route path="*" element={<Navigate to={destination('apis')} replace />} />
        </Routes>
      </main>
    </div>
  )
}

function ProjectShell() {
  const [params, setParams] = useSearchParams()
  const [remembered, setRemembered] = useState(() => localStorage.getItem(projectPreference))
  const [sessions] = useState(() => new Map<string, {
    cache: QueryClient; drafts: DraftSession; api: ReturnType<typeof projectApi>
  }>())
  const [dialog, setDialog] = useState<{ name: string; id?: string }>()
  const cache = useQueryClient()
  const catalog = useQuery({ queryKey: ['projects'], queryFn: projectCatalog.list })
  const requested = params.get('project')
  const preferred = requested ?? (params.has('id') ? defaultProjectId : remembered)
  const current = catalog.data?.find((item) => item.id === preferred)
    ?? (requested ? undefined : catalog.data?.find((item) => item.id === defaultProjectId))

  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => {
      if ([...sessions.values()].some((session) => session.drafts.unsafe.size)) event.preventDefault()
    }
    window.addEventListener('beforeunload', protect)
    return () => window.removeEventListener('beforeunload', protect)
  }, [sessions])

  function changeProject(id: string) {
    setRemembered(id)
    localStorage.setItem(projectPreference, id)
    setParams({ project: id })
  }

  const save = useMutation({
    mutationFn: ({ name, id }: { name: string; id?: string }) => projectCatalog.save(name.trim(), id),
    onSuccess: (project, input) => {
      cache.setQueryData(['projects'], (previous: Project[] = []) =>
        previous.some((item) => item.id === project.id)
          ? previous.map((item) => item.id === project.id ? project : item)
          : [...previous, project])
      if (!input.id) changeProject(project.id)
      setDialog(undefined)
    },
  })
  function editProject(action: 'create' | 'rename') {
    save.reset()
    setDialog(action === 'rename' && current ? { name: current.name, id: current.id } : { name: '' })
  }

  const picker = <div className="project-picker">
    <Select aria-label="当前项目" value={current?.id} placeholder="选择项目"
      options={catalog.data?.map((item) => ({ value: item.id, label: item.name }))}
      loading={catalog.isPending} onChange={changeProject} />
    <Dropdown trigger={['click']} menu={{ items: [
      { key: 'create', label: '新建项目' },
      { key: 'rename', label: '重命名当前项目', disabled: !current },
    ], onClick: ({ key }) => editProject(key === 'rename' ? 'rename' : 'create') }}>
      <Button aria-label="项目管理" icon={<MoreOutlined />} />
    </Dropdown>
  </div>

  let session = current && sessions.get(current.id)
  if (current && !session) {
    session = { cache: newCache(), drafts: new DraftSession(), api: projectApi(current.id) }
    sessions.set(current.id, session)
  }

  return <>
    {session && current
      ? <QueryClientProvider key={current.id} client={session.cache}>
        <ProjectApiContext.Provider value={session.api}>
          <DraftContext.Provider value={session.drafts}>
            <Workspace projectId={current.id} picker={picker} />
          </DraftContext.Provider>
        </ProjectApiContext.Provider>
      </QueryClientProvider>
      : <main className="app-main">
        {picker}
        {catalog.isPending ? <Spin />
          : catalog.error ? <Alert type="error" title="无法载入项目" description={apiErrorMessage(catalog.error)} />
            : <Alert type="warning" title="项目不存在，请选择可用项目。" />}
      </main>}
    <Modal title={dialog?.id ? '重命名项目' : '新建项目'} open={Boolean(dialog)} okText="保存" cancelText="取消"
      onOk={() => dialog && save.mutate(dialog)} okButtonProps={{ disabled: !dialog?.name.trim() }}
      confirmLoading={save.isPending} onCancel={() => { if (!save.isPending) setDialog(undefined) }}>
      <Input aria-label="项目名称" maxLength={80} value={dialog?.name ?? ''}
        onChange={(event) => setDialog((value) => value && { ...value, name: event.target.value })}
        onPressEnter={() => { if (dialog?.name.trim() && !save.isPending) save.mutate(dialog) }} />
      {save.error && <Alert type="error" title={apiErrorMessage(save.error)} />}
    </Modal>
  </>
}

createRoot(document.getElementById('root')!).render(
  <IceThemeProvider>
    <AntApp>
      <QueryClientProvider client={queries}>
        <BrowserRouter><ProjectShell /></BrowserRouter>
      </QueryClientProvider>
    </AntApp>
  </IceThemeProvider>,
)
