import axios from 'axios'
import type { WorkflowDefinition } from './graph-types'

export type {
  WorkflowDefinition, WorkflowEdge, WorkflowFieldMapping, WorkflowNode, WorkflowRegion,
  WorkflowRuntimeInputDefinition,
} from './graph-types'

export const httpMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE'] as const
export type HttpMethod = (typeof httpMethods)[number]
export const client = axios.create({ baseURL: '/api', timeout: 0 })

export function apiErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const detail: unknown = error.response?.data?.detail
    if (typeof detail === 'string') return detail
  }
  return error instanceof Error ? error.message : String(error)
}

type Identity = { id: string; revision: number; updated_at: string }

export type ApiAssertion = {
  kind: string
  operator: string
  target: string | null
  expected: unknown
}
export type AssertionResult = ApiAssertion & {
  id: string
  actual: unknown
  passed: boolean
  message: string
}
export type RequestDefinition = {
  method: HttpMethod
  path: string
  query_parameters: Array<{ name: string; value: string; enabled: boolean }>
  headers: Record<string, string>
  variables: Record<string, string>
  body_kind: 'none' | 'json' | 'raw' | 'form' | 'multipart'
  body: unknown
  auth_kind: 'none' | 'bearer' | 'basic' | 'api_key'
  auth_config: Record<string, string>
  extraction_rules: Array<{ name: string; kind: 'jsonpath' | 'jmespath' | 'header'; expression: string }>
  assertions: ApiAssertion[]
}
export type ApiInput = {
  name: string
  group: string
  description: string
  base_url: string
  request: RequestDefinition
}
export type ApiAsset = ApiInput & Identity
export type ApiDefinition = {
  id: string
  name: string
  method: HttpMethod
  path: string
  current_version: number
}
export type ApiVersion = RequestDefinition & { api_definition_id: string; version: number }
export type ApiDetail = { definition: ApiDefinition; version: ApiVersion }
export type ApiVersionInput = RequestDefinition & { base_version: number }

export function apiDefinition(asset: ApiAsset): ApiDefinition {
  return {
    id: asset.id, name: asset.name, method: asset.request.method,
    path: asset.request.path, current_version: asset.revision,
  }
}

export function apiDetail(asset: ApiAsset): ApiDetail {
  return {
    definition: apiDefinition(asset),
    version: { ...asset.request, api_definition_id: asset.id, version: asset.revision },
  }
}

export type CommonSettings = { base_url: string; variables: Record<string, string>; headers: Record<string, string> }
export type EnvironmentInput = CommonSettings & { name: string }
export type Environment = EnvironmentInput & Identity
export type Artifact = {
  id: string
  filename: string
  content_type: string
  size_bytes: number
  sha256: string
  created_at: string
}
export type WorkflowInput = {
  name: string
  definition: WorkflowDefinition
  inputs: Record<string, unknown>
}
export type Workflow = WorkflowInput & Identity
export type RequestSnapshot = { method: string; url: string; headers: Record<string, string>; body: unknown }
export type ResponseSnapshot = { status_code: number; headers: Record<string, string>; body: unknown; size_bytes: number; duration_ms?: number }
export type InterfaceRun = {
  execution: {
    id: string; status: string; elapsed_ms: number
    error_code: string | null; error_message: string | null
  }
  request: RequestSnapshot | null
  response: ResponseSnapshot | null
  assertions: AssertionResult[]
  extracted: Record<string, unknown>
}
export type Observation = {
  attempt: number
  request: RequestSnapshot
  response: ResponseSnapshot | null
  mappings: unknown[]
  duration_ms: number
  error_message: string | null
}
export type NodeExecution = {
  node_id: string
  name: string
  status: string
  attempts: number
  started_at: string | null
  occurred_at: string
  error_code: string | null
  error_message: string | null
  result: {
    observations: Observation[]
    assertions: Array<{ name: string; passed: boolean; actual: unknown; expected: unknown; message: string }>
    output: unknown
  } | null
}
export type FlowRun = { id: string; workflow_id: string; status: string; nodes: NodeExecution[]; error: string | null }
export type ImportCandidate = {
  asset: ApiInput
  diagnostics: Array<{ code: string; message: string }>
}

type AssetContracts = {
  api: [ApiInput, ApiAsset]
  workflow: [WorkflowInput, Workflow]
  environment: [EnvironmentInput, Environment]
}
type Kind = keyof AssetContracts

export function listAssets<K extends Kind>(kind: K): Promise<Array<AssetContracts[K][1]>> {
  return client.get(`/assets/${kind}`).then((res) => res.data)
}
export function getAsset<K extends Kind>(kind: K, id: string): Promise<AssetContracts[K][1]> {
  return client.get(`/assets/${kind}/${id}`).then((res) => res.data)
}
export function createAsset<K extends Kind>(kind: K, asset: AssetContracts[K][0]): Promise<AssetContracts[K][1]> {
  return client.post(`/assets/${kind}`, asset).then((res) => res.data)
}
export function updateAsset<K extends Kind>(
  kind: K, id: string, revision: number, asset: AssetContracts[K][0],
): Promise<AssetContracts[K][1]> {
  return client.put(`/assets/${kind}/${id}`, asset, { params: { revision } }).then((res) => res.data)
}
export async function deleteAsset(kind: Kind, id: string): Promise<void> {
  await client.delete(`/assets/${kind}/${id}`)
}
