import { createContext, useContext, useLayoutEffect, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { projectApi } from './api'

export const ProjectApiContext = createContext<ReturnType<typeof projectApi> | null>(null)

export function useProjectApi() {
  const api = useContext(ProjectApiContext)
  if (!api) throw new Error('缺少项目上下文')
  return api
}

export function useAssetSelection() {
  const { projectId } = useProjectApi()
  const [params, setParams] = useSearchParams()
  const mounted = useRef(false)
  useLayoutEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  function select(id?: string) {
    if (!mounted.current) return
    setParams((previous) => {
      const next = new URLSearchParams(previous)
      next.set('project', projectId)
      if (id) next.set('id', id)
      else next.delete('id')
      return next
    })
  }
  return [params.get('id'), select] as const
}
