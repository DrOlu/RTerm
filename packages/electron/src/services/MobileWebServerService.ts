import http from 'http'
import fs from 'fs'
import path from 'path'
import { networkInterfaces } from 'os'
import net from 'net'

export interface MobileWebServerStatus {
  running: boolean
  port?: number
  urls?: string[]
}

export interface MobileWebGatewayTarget {
  port: number
}

export class MobileWebServerService {
  private server: http.Server | null = null
  private currentPort: number | null = null

  constructor(
    private readonly runtimePath: string,
    private readonly getGatewayTarget?: () => MobileWebGatewayTarget | null
  ) {}

  getStatus(): MobileWebServerStatus {
    if (!this.server || this.currentPort === null) {
      return { running: false }
    }
    return {
      running: true,
      port: this.currentPort,
      urls: this.getLanUrls(this.currentPort)
    }
  }

  async start(preferredPort: number | null): Promise<MobileWebServerStatus> {
    await this.stop()

    const port = preferredPort ?? await this.findFreePort()
    const runtimeRoot = path.resolve(this.runtimePath)
    const indexPath = path.join(runtimeRoot, 'index.html')
    if (!fs.existsSync(indexPath)) {
      throw new Error(`[MobileWebServerService] Mobile web runtime is missing index.html: ${indexPath}`)
    }

    this.server = http.createServer((req, res) => {
      const filePath = this.resolveRequestPath(runtimeRoot, req.url || '/')
      if (!filePath) {
        res.writeHead(403)
        res.end('Forbidden')
        return
      }

      const serveFile = (fp: string) => {
        fs.readFile(fp, (err, data) => {
          if (err) {
            res.writeHead(404)
            res.end('Not found')
            return
          }
          const ext = path.extname(fp).toLowerCase()
          const mimeTypes: Record<string, string> = {
            '.html': 'text/html; charset=utf-8',
            '.js': 'application/javascript',
            '.css': 'text/css',
            '.json': 'application/json',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.svg': 'image/svg+xml',
            '.ico': 'image/x-icon',
            '.woff': 'font/woff',
            '.woff2': 'font/woff2',
          }
          res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' })
          res.end(data)
        })
      }

      fs.stat(filePath, (err, stat) => {
        if (err || !stat.isFile()) {
          // SPA fallback: serve index.html
          serveFile(path.join(runtimeRoot, 'index.html'))
        } else {
          serveFile(filePath)
        }
      })
    })

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(port, '0.0.0.0', () => resolve())
      this.server!.on('error', (err) => reject(err))
    })

    this.currentPort = port
    console.log(`[MobileWebServerService] Started on port ${port}`)
    return this.getStatus()
  }

  async stop(): Promise<void> {
    if (!this.server) return
    const server = this.server
    this.server = null
    this.currentPort = null
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
    console.log('[MobileWebServerService] Stopped')
  }

  private resolveRequestPath(runtimeRoot: string, rawUrl: string): string | null {
    const rawPath = rawUrl.split('?')[0] || '/'
    let decodedPath: string
    try {
      decodedPath = decodeURIComponent(rawPath)
    } catch {
      return null
    }

    const normalizedPath = path.posix.normalize(decodedPath.replace(/\\/g, '/'))
    const relativePath = normalizedPath.replace(/^\/+/, '') || 'index.html'
    const resolvedPath = path.resolve(runtimeRoot, relativePath)
    const relativeToRoot = path.relative(runtimeRoot, resolvedPath)
    if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
      return null
    }
    return resolvedPath
  }

  private getLanUrls(port: number): string[] {
    const gatewayTarget = this.getGatewayTarget?.() ?? null
    const ifaces = networkInterfaces()
    const urls: string[] = []
    for (const name of Object.keys(ifaces)) {
      for (const iface of (ifaces[name] || [])) {
        if (iface.family === 'IPv4' && !iface.internal) {
          urls.push(this.buildAccessUrl(iface.address, port, gatewayTarget))
        }
      }
    }
    if (urls.length === 0) {
      urls.push(this.buildAccessUrl('localhost', port, gatewayTarget))
    }
    return urls
  }

  private buildAccessUrl(host: string, port: number, gatewayTarget: MobileWebGatewayTarget | null): string {
    const accessUrl = new URL(`http://${host}:${port}`)
    if (gatewayTarget) {
      accessUrl.searchParams.set('gateway', `ws://${host}:${gatewayTarget.port}`)
    }
    return accessUrl.toString()
  }

  private async findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer()
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        const port = typeof addr === 'object' && addr ? addr.port : 0
        server.close(() => {
          if (port > 0) resolve(port)
          else reject(new Error('Failed to find free port'))
        })
      })
      server.on('error', reject)
    })
  }
}
