import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { App as AntApp } from 'antd'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, NavLink, Route, Routes } from 'react-router-dom'
import IceThemeProvider from './theme/IceThemeProvider'
import { applyIceAppearance } from './theme/ice-theme'
import { DraftContext, DraftSession } from './features/drafts/draft-session'
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
  function selectEnvironment(value?: string) {
    setEnvironment(value)
    if (value) localStorage.setItem('flowtest-lite:environment', value)
    else localStorage.removeItem('flowtest-lite:environment')
  }
  const context = { environment, selectEnvironment }
  return (
    <>
      <header className="app-header">
        <strong>FlowTest-Lite</strong>
        <nav aria-label="主导航">
          <NavLink to="/apis">接口</NavLink>
          <NavLink to="/flows">流程</NavLink>
        </nav>
      </header>
      <main className="app-main">
        <Routes>
          <Route path="/flows" element={<FlowsPage {...context} />} />
          <Route path="/apis" element={<ApiPage {...context} />} />
          <Route path="*" element={<Navigate to="/apis" replace />} />
        </Routes>
      </main>
    </>
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
