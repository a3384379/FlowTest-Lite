import type { WorkflowNodeEditorDraft } from '../../flow/editor/node-edit-session'
import { createContext, useContext, useState } from 'react'
import type { Workflow } from '../../lib/api'
import type { WorkbenchFields } from '../api-console/APIWorkbench'


type ApiDraft = {
  fields: WorkbenchFields
  generation: number
  baseVersion: number
}
export class DraftSession {
  readonly nodeEditors = new Map<string, WorkflowNodeEditorDraft>()
  readonly nodeEditorActions = new Map<string, () => Promise<boolean>>()
  updateNodeEditor(key: string, draft: WorkflowNodeEditorDraft) {
    this.nodeEditors.set(key, draft)
    this.markUnsafe(`node-editor:${key}`, draft.dirty)
  }
  clearNodeEditor(key: string) {
    this.nodeEditors.delete(key)
    this.markUnsafe(`node-editor:${key}`, false)
  }
  dirtyNodeEditorKeys(scope: string): string[] {
    return [...this.nodeEditors]
      .filter(([key, draft]) => key.startsWith(scope) && draft.dirty)
      .map(([key]) => key)
  }

  readonly workflows = new Map<string, Workflow>()
  readonly apis = new Map<string, ApiDraft>()
  readonly unsafe = new Set<string>()
  private revision = 0
  private generation = 0
  private readonly listeners = new Set<() => void>()
  nextGeneration() {
    return ++this.generation
  }
  markUnsafe(key: string, unsafe: boolean) {
    if (unsafe) this.unsafe.add(key)
    else this.unsafe.delete(key)
    this.revision += 1
    this.listeners.forEach((listener) => listener())
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  snapshot = () => this.revision
}
export const DraftContext = createContext<DraftSession | null>(null)
export function useDraftSession() {
  const provided = useContext(DraftContext)
  const [local] = useState(() => new DraftSession())
  return provided ?? local
}
