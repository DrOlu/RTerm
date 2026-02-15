export type MessageType =
  | 'text'
  | 'command'
  | 'tool_call'
  | 'file_edit'
  | 'sub_tool'
  | 'reasoning'
  | 'alert'
  | 'error'
  | 'ask'
  | 'tokens_count'

export interface ChatMessage {
  id: string
  backendMessageId?: string
  role: 'user' | 'assistant' | 'system'
  type: MessageType
  content: string
  metadata?: {
    tabName?: string
    commandId?: string
    exitCode?: number
    output?: string
    diff?: string
    filePath?: string
    action?: 'created' | 'edited' | 'error'
    collapsed?: boolean
    isNowait?: boolean
    toolName?: string
    subToolTitle?: string
    subToolHint?: string
    subToolLevel?: 'info' | 'warning' | 'error'
    approvalId?: string
    decision?: 'allow' | 'deny'
    command?: string
    modelName?: string
    totalTokens?: number
    maxTokens?: number
    details?: string
    inputKind?: 'normal' | 'inserted'
  }
  timestamp: number
  streaming?: boolean
}

export type UIUpdateAction =
  | { type: 'ADD_MESSAGE'; sessionId: string; message: ChatMessage }
  | { type: 'REMOVE_MESSAGE'; sessionId: string; messageId: string }
  | { type: 'APPEND_CONTENT'; sessionId: string; messageId: string; content: string }
  | { type: 'APPEND_OUTPUT'; sessionId: string; messageId: string; outputDelta: string }
  | { type: 'UPDATE_MESSAGE'; sessionId: string; messageId: string; patch: Partial<ChatMessage> }
  | { type: 'DONE'; sessionId: string }
  | { type: 'SESSION_READY'; sessionId: string }
  | { type: 'ROLLBACK'; sessionId: string; messageId: string }

export interface GatewayEvent {
  id: string
  timestamp: number
  type: 'agent:event' | 'session:update' | 'ui:action' | 'system:notification'
  sessionId?: string
  payload: unknown
}

export interface GatewaySessionSummary {
  id: string
  title: string
  updatedAt: number
  messagesCount: number
  lastMessagePreview?: string
  isBusy: boolean
}

export interface GatewaySessionSnapshot {
  id: string
  title: string
  updatedAt: number
  messages: ChatMessage[]
  isBusy: boolean
}

export interface SkillSummary {
  name: string
  description?: string
  enabled?: boolean
  fileName?: string
  filePath?: string
  baseDir?: string
  scanRoot?: string
  isNested?: boolean
  supportingFiles?: string[]
}

export interface GatewayTerminalSummary {
  id: string
  title: string
  type: string
}

export interface GatewayProfileSummary {
  id: string
  name: string
  globalModelId: string
  modelName?: string
}

export interface RpcRequest {
  id?: string
  method: string
  params?: Record<string, unknown>
}

export interface RpcSuccessResponse {
  type: 'gateway:response'
  id: string
  ok: true
  result: unknown
}

export interface RpcErrorResponse {
  type: 'gateway:response'
  id: string
  ok: false
  error: {
    code: string
    message: string
  }
}

export interface GatewayEventEnvelope {
  type: 'gateway:event'
  payload: GatewayEvent
}

export interface GatewayUiUpdateEnvelope {
  type: 'gateway:ui-update'
  payload: UIUpdateAction
}

export interface GatewayRawEnvelope {
  type: 'gateway:raw'
  channel: string
  payload: unknown
}

export type GatewayIncomingEnvelope =
  | RpcSuccessResponse
  | RpcErrorResponse
  | GatewayEventEnvelope
  | GatewayUiUpdateEnvelope
  | GatewayRawEnvelope
