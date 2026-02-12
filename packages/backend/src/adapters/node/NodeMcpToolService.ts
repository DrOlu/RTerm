import path from 'node:path'
import {
  McpRuntimeCore,
  type McpServerStatus,
  type McpServerConfig,
  type McpConfigFile,
  type McpServerSummary
} from '../../mcp/McpRuntimeCore'

export type { McpServerStatus, McpServerConfig, McpConfigFile, McpServerSummary }

export class NodeMcpToolService extends McpRuntimeCore {
  constructor(dataDir: string) {
    super({
      getConfigPath: () => path.join(dataDir, 'mcp.json'),
      logger: {
        info: (message: string) => console.info(message),
        warn: (message: string, error?: unknown) => console.warn(message, error),
        error: (message: string, error?: unknown) => console.error(message, error)
      }
    })
  }
}
