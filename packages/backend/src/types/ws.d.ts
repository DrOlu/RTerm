declare module 'ws' {
  export class WebSocketServer {
    constructor(options: { host?: string; port?: number })
    on(event: 'connection', listener: (socket: any, request?: any) => void): void
    close(callback?: (error?: Error) => void): void
  }
}
