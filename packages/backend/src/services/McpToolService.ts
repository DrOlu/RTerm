import fs from 'node:fs/promises'
import path from 'node:path'
import { app, shell } from 'electron'
import {
  McpRuntimeCore,
  type McpServerStatus,
  type McpServerConfig,
  type McpConfigFile,
  type McpServerSummary
} from '../mcp/McpRuntimeCore'

export type { McpServerStatus, McpServerConfig, McpConfigFile, McpServerSummary }

export class McpToolService extends McpRuntimeCore {
  constructor() {
    super({
      getConfigPath: () => path.join(app.getPath('userData'), 'mcp.json'),
      openPath: async (absolutePath: string) => {
        await shell.openPath(absolutePath)
      },
      readTemplateConfig: async () => {
        try {
          const templatePath = path.join(app.getAppPath(), 'mcp.json')
          const raw = await fs.readFile(templatePath, 'utf8')
          const parsed = JSON.parse(raw)
          if (parsed && typeof parsed === 'object') {
            return parsed as McpConfigFile
          }
        } catch {
          // ignore and fallback to default config
        }
        return undefined
      },
      logger: {
        info: (message: string) => console.info(message),
        warn: (message: string, error?: unknown) => console.warn(message, error),
        error: (message: string, error?: unknown) => console.error(message, error)
      }
    })
  }
}
