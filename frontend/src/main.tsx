import { useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ApartmentOutlined, ApiOutlined } from '@ant-design/icons'
import { App as AntApp } from 'antd'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, NavLink, Route, Routes } from 'react-router-dom'
import IceThemeProvider from './theme/IceThemeProvider'
import { applyIceAppearance } from './theme/ice-theme'
import { DraftContext, DraftSession } from './features/drafts/draft-session'
import EnvironmentToolbar from './components/EnvironmentToolbar'
import ApiPage from './pages/ApiPage'
import FlowsPage from './pages/FlowsPage'
import './styles.css'

applyIceAppearance(document.documentElement)
const queries = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 5_000 } },
})
const draftSession = new DraftSession()

function Workspace() {
  const [environment, setEnvironment] = useState<string | undefined>(
    () => localStorage.getItem('flowtest-lite:environment') ?? undefined,
  )
  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => {
      if (draftSession.unsafe.size) event.preventDefault()
    }
    window.addEventListener('beforeunload', protect)
    return () => window.removeEventListener('beforeunload', protect)
  }, [])
  const selectEnvironment = useCallback((value?: string) => {
    setEnvironment(value)
    if (value) localStorage.setItem('flowtest-lite:environment', value)
    else localStorage.removeItem('flowtest-lite:environment')
  }, [])
  const context = { environment, selectEnvironment }
  return (
    <div className="app-shell">
      <nav className="app-rail" aria-label="主导航">
        <NavLink to="/apis" aria-label="接口管理"><ApiOutlined /><span>接口</span></NavLink>
        <NavLink to="/flows" aria-label="流程编排"><ApartmentOutlined /><span>编排</span></NavLink>
      </nav>
      <header className="app-header">
        <NavLink to="/apis" className="app-brand" aria-label="FlowTest-Lite 首页">
          <span className="app-brand-mark"><ApiOutlined /></span>
          <strong>FlowTest<span className="app-brand-edition"> Lite</span></strong>
        </NavLink>
        <EnvironmentToolbar {...context} />
      </header>
      <main className="app-main">
        <Routes>
          <Route path="/flows" element={<FlowsPage environment={environment} />} />
          <Route path="/apis" element={<ApiPage environment={environment} />} />
          <Route path="*" element={<Navigate to="/apis" replace />} />
        </Routes>
      </main>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <IceThemeProvider>
      <AntApp>
        <QueryClientProvider client={queries}>
          <DraftContext.Provider value={draftSession}>
            <BrowserRouter><Workspace /></BrowserRouter>
          </DraftContext.Provider>
        </QueryClientProvider>
      </AntApp>
  </IceThemeProvider>,
)
