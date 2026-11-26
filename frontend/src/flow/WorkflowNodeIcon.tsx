import {
  ApiOutlined, ApartmentOutlined, BranchesOutlined, CheckCircleOutlined, ClockCircleOutlined,
  ExportOutlined, FileTextOutlined, FlagOutlined, GroupOutlined, PlayCircleOutlined, RetweetOutlined, SafetyOutlined,
  RollbackOutlined, StopOutlined, UnorderedListOutlined,
} from '@ant-design/icons'
import type { ReactNode } from 'react'
import type { WorkflowNode } from '../lib/api'
import type { ControlBlockKind } from './editor/control-blocks'

const icons: Record<WorkflowNode['type'], ReactNode> = {
  start: <PlayCircleOutlined />,
  end: <FlagOutlined />,
  api: <ApiOutlined />,
  extract: <ExportOutlined />,
  assert: <CheckCircleOutlined />,
  condition: <BranchesOutlined />,
  delay: <ClockCircleOutlined />,
  capability: <ApartmentOutlined />,
}

const controlIcons: Record<ControlBlockKind, ReactNode> = {
  repeat: <RetweetOutlined />,
  foreach: <UnorderedListOutlined />,
  while: <RetweetOutlined />,
  do_while: <RetweetOutlined />,
  until: <RetweetOutlined />,
  if: <BranchesOutlined />,
  switch: <BranchesOutlined />,
  parallel: <ApartmentOutlined />,
  try: <SafetyOutlined />,
  group: <GroupOutlined />,
  fail: <StopOutlined />,
  return: <RollbackOutlined />,
}

export default function WorkflowNodeIcon({ type, control }: {
  type: WorkflowNode['type']
  control?: string
}) {
  const icon = control && Object.hasOwn(controlIcons, control) ? controlIcons[control as ControlBlockKind] : icons[type]
  return <span className="flow-node-icon" data-node-type={type} aria-hidden="true">{icon}</span>
}

export function NodeNoteIndicator({ note }: { note?: string }) {
  if (!note?.trim()) return null
  return <span className="flow-node-note-indicator" title={note} aria-label={`节点备注：${note}`}>
    <FileTextOutlined aria-hidden="true" />
  </span>
}
