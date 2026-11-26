export type WorkflowNode = {
  id: string
  type:
    | 'start'
    | 'api'
    | 'extract'
    | 'assert'
    | 'condition'
    | 'delay'
    | 'capability'
    | 'end'
  name: string
  note?: string
  position: { x: number; y: number }
  config: Record<string, unknown>
  capability_id?: string
  capability_version?: string
  configuration?: Record<string, unknown>
  bindings?: Array<{ input: string; expression: string }>
  phase?: 'main' | 'cleanup'
  run_when?: 'success' | 'failure' | 'cancel' | 'always'
  cleanup_for?: string[]
  best_effort?: boolean
  cleanup_timeout_seconds?: number
  cleanup_retry_budget?: number
}

export type WorkflowFieldMapping = {
  source: { node_id: string; path: string }
  transform: { kind: 'identity' | 'template' | 'json_parse'; template: string }
  target: {
    node_id: string
    location: 'query' | 'header' | 'body' | 'variable'
    key: string
  }
}

export type WorkflowEdge = {
  id: string
  source: string
  target: string
  condition: 'true' | 'false' | null
  mappings: WorkflowFieldMapping[]
}

export type WorkflowRuntimeInputDefinition = {
  name: string
  value_type: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array'
  required: boolean
  nullable: boolean
  description: string
}

export type WorkflowRegion = {
  id: string
  owner_node_id: string
  role: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  entry_node_id: string | null
  exit_node_ids: string[]
  inputs: Record<string, unknown>
  outputs: Record<string, unknown>
}

export type WorkflowDefinition = {
  runtime_inputs?: WorkflowRuntimeInputDefinition[]
  schema_version: string
  variables: Record<string, string>
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  regions?: WorkflowRegion[]
  settings: {
    fail_fast: boolean
    concurrency: number
    default_timeout_seconds: number
  }
  run_policy?: {
    request_budget: number | null
    max_runtime_seconds: number | null
    cleanup_request_budget: number | null
    force_cancel_skips_cleanup: boolean
  }
}
