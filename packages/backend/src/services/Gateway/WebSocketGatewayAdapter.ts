import type { IGatewayRuntime, StartTaskOptions } from './types';
import { WebSocketClientTransport, type IWebSocketConnectionLike } from './WebSocketClientTransport';
import { WebSocketServer } from 'ws';

type WebSocketRpcMethod =
  | 'gateway:ping'
  | 'gateway:createSession'
  | 'session:list'
  | 'session:get'
  | 'agent:exportHistory'
  | 'agent:getAllChatHistory'
  | 'agent:loadChatSession'
  | 'agent:getUiMessages'
  | 'terminal:list'
  | 'terminal:createTab'
  | 'terminal:write'
  | 'terminal:writePaths'
  | 'terminal:resize'
  | 'terminal:kill'
  | 'terminal:setSelection'
  | 'system:saveTempPaste'
  | 'models:getProfiles'
  | 'models:setActiveProfile'
  | 'models:probe'
  | 'skills:reload'
  | 'skills:getAll'
  | 'skills:getEnabled'
  | 'skills:create'
  | 'skills:delete'
  | 'skills:list'
  | 'skills:setEnabled'
  | 'settings:get'
  | 'settings:set'
  | 'settings:getCommandPolicyLists'
  | 'settings:addCommandPolicyRule'
  | 'settings:deleteCommandPolicyRule'
  | 'tools:reloadMcp'
  | 'tools:getMcp'
  | 'tools:setMcpEnabled'
  | 'tools:getBuiltIn'
  | 'tools:setBuiltInEnabled'
  | 'agent:startTask'
  | 'agent:startTaskAsync'
  | 'agent:stopTask'
  | 'agent:replyMessage'
  | 'agent:replyCommandApproval'
  | 'agent:deleteChatSession'
  | 'agent:renameSession'
  | 'agent:rollbackToMessage';

interface WebSocketRpcRequest {
  id?: string | number;
  method: WebSocketRpcMethod | string;
  params?: Record<string, any>;
}

export interface IWebSocketServerLike {
  on(event: 'connection', listener: (socket: IWebSocketConnectionLike, request?: any) => void): void;
  on(event: 'error', listener: (error: unknown) => void): void;
  close(callback?: (error?: Error) => void): void;
}

export type WebSocketServerFactory = (options: { host: string; port: number }) => IWebSocketServerLike;

export interface IWebSocketGatewayAdapterLogger {
  info(message: string): void;
  warn(message: string, error?: unknown): void;
  error(message: string, error?: unknown): void;
}

export interface WebSocketGatewayAdapterOptions {
  host: string;
  port: number;
  agentBridge?: {
    exportHistory?: (sessionId: string, mode: 'simple' | 'detailed') => unknown | Promise<unknown>;
    getAllChatHistory?: () => unknown | Promise<unknown>;
    loadChatSession?: (sessionId: string) => unknown | Promise<unknown>;
    getUiMessages?: (sessionId: string) => unknown | Promise<unknown>;
  };
  terminalBridge?: {
    listTerminals: () => Array<{ id: string; title: string; type: string }>;
    createTab?: (config: Record<string, any>) => Promise<{ id: string }> | { id: string };
    write?: (terminalId: string, data: string) => void | Promise<void>;
    writePaths?: (terminalId: string, paths: string[]) => void | Promise<void>;
    resize?: (terminalId: string, cols: number, rows: number) => void | Promise<void>;
    kill?: (terminalId: string) => void | Promise<void>;
    setSelection?: (terminalId: string, selectionText: string) => void | Promise<void>;
  };
  profileBridge?: {
    getProfiles: () => {
      activeProfileId: string;
      profiles: Array<{ id: string; name: string; globalModelId: string; modelName?: string }>;
    };
    setActiveProfile: (profileId: string) => {
      activeProfileId: string;
      profiles: Array<{ id: string; name: string; globalModelId: string; modelName?: string }>;
    };
    probeModel?: (model: unknown) => unknown | Promise<unknown>;
  };
  systemBridge?: {
    saveTempPaste?: (content: string) => Promise<string> | string;
  };
  skillBridge?: {
    reload?: () => unknown | Promise<unknown>;
    getAll?: () => unknown | Promise<unknown>;
    getEnabled?: () => unknown | Promise<unknown>;
    create?: () => unknown | Promise<unknown>;
    delete?: (fileName: string) => unknown | Promise<unknown>;
    listSkills: () =>
      | Array<{ name: string; description?: string; enabled: boolean }>
      | Promise<Array<{ name: string; description?: string; enabled: boolean }>>;
    setSkillEnabled?: (
      name: string,
      enabled: boolean
    ) =>
      | Array<{ name: string; description?: string; enabled: boolean }>
      | Promise<Array<{ name: string; description?: string; enabled: boolean }>>;
  };
  settingsBridge?: {
    getSettings?: () => unknown | Promise<unknown>;
    setSettings?: (settings: Record<string, any>) => unknown | Promise<unknown>;
  };
  commandPolicyBridge?: {
    getLists?: () => unknown | Promise<unknown>;
    addRule?: (listName: 'allowlist' | 'denylist' | 'asklist', rule: string) => unknown | Promise<unknown>;
    deleteRule?: (listName: 'allowlist' | 'denylist' | 'asklist', rule: string) => unknown | Promise<unknown>;
  };
  toolsBridge?: {
    reloadMcp?: () => unknown | Promise<unknown>;
    getMcp?: () => unknown | Promise<unknown>;
    setMcpEnabled?: (name: string, enabled: boolean) => unknown | Promise<unknown>;
    getBuiltIn?: () => unknown | Promise<unknown>;
    setBuiltInEnabled?: (name: string, enabled: boolean) => unknown | Promise<unknown>;
  };
  serverFactory?: WebSocketServerFactory;
  logger?: IWebSocketGatewayAdapterLogger;
}

class WebSocketRpcError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export function createDefaultWebSocketServerFactory(): WebSocketServerFactory {
  return ({ host, port }) => {
    return new WebSocketServer({ host, port }) as unknown as IWebSocketServerLike;
  };
}

/**
 * Websocket adapter for Gateway runtime. It is transport-only and does not own business logic.
 */
export class WebSocketGatewayAdapter {
  private server: IWebSocketServerLike | null = null;
  private transportIdBySocket: Map<IWebSocketConnectionLike, string> = new Map();
  private readonly serverFactory: WebSocketServerFactory;
  private readonly logger: IWebSocketGatewayAdapterLogger;

  constructor(
    private gateway: IGatewayRuntime,
    private options: WebSocketGatewayAdapterOptions
  ) {
    this.serverFactory = options.serverFactory ?? createDefaultWebSocketServerFactory();
    this.logger = options.logger ?? console;
  }

  start(): void {
    if (this.server) return;
    this.server = this.serverFactory({ host: this.options.host, port: this.options.port });
    this.server.on('error', (error) => {
      this.logger.error('[WebSocketGatewayAdapter] Server error.', error);
    });
    this.server.on('connection', (socket, request) => this.handleConnection(socket, request));
    this.logger.info(`[WebSocketGatewayAdapter] Listening on ws://${this.options.host}:${this.options.port}`);
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((error?: Error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    this.transportIdBySocket.clear();
    this.logger.info('[WebSocketGatewayAdapter] Stopped.');
  }

  private handleConnection(socket: IWebSocketConnectionLike, request?: any): void {
    const remote = request?.socket?.remoteAddress || 'unknown';
    const transport = new WebSocketClientTransport(socket, this.logger);
    this.transportIdBySocket.set(socket, transport.id);
    this.gateway.registerTransport(transport);
    this.logger.info(`[WebSocketGatewayAdapter] Client connected: ${remote} (${transport.id})`);

    socket.on('message', (raw: unknown) => {
      void this.handleIncomingMessage(socket, raw);
    });

    socket.on('close', () => {
      this.cleanupSocket(socket);
    });

    socket.on('error', (error: unknown) => {
      this.logger.warn(`[WebSocketGatewayAdapter] Client socket error (${transport.id}).`, error);
    });
  }

  private cleanupSocket(socket: IWebSocketConnectionLike): void {
    const transportId = this.transportIdBySocket.get(socket);
    if (!transportId) return;
    this.transportIdBySocket.delete(socket);
    this.gateway.unregisterTransport(transportId);
    this.logger.info(`[WebSocketGatewayAdapter] Client disconnected: ${transportId}`);
  }

  private async handleIncomingMessage(socket: IWebSocketConnectionLike, raw: unknown): Promise<void> {
    let requestId: string | undefined;
    try {
      const parsed = this.parseRequest(raw);
      requestId = parsed.id !== undefined ? String(parsed.id) : undefined;
      const result = await this.executeRequest(parsed);
      if (requestId) {
        this.sendRpcSuccess(socket, requestId, result);
      }
    } catch (error) {
      const rpcError = this.normalizeRpcError(error);
      if (requestId) {
        this.sendRpcFailure(socket, requestId, rpcError.code, rpcError.message);
        return;
      }
      this.logger.warn(
        `[WebSocketGatewayAdapter] Dropped invalid notification (${rpcError.code}): ${rpcError.message}`
      );
    }
  }

  private parseRequest(raw: unknown): WebSocketRpcRequest {
    const text = this.coerceRawMessage(raw);
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new WebSocketRpcError('BAD_JSON', 'Incoming websocket message is not valid JSON.');
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new WebSocketRpcError('BAD_REQUEST', 'Websocket request payload must be an object.');
    }
    const request = payload as WebSocketRpcRequest;
    if (typeof request.method !== 'string' || request.method.length === 0) {
      throw new WebSocketRpcError('BAD_REQUEST', 'Websocket request method must be a non-empty string.');
    }
    return request;
  }

  private coerceRawMessage(raw: unknown): string {
    if (typeof raw === 'string') return raw;
    if (Buffer.isBuffer(raw)) return raw.toString('utf8');
    if (Array.isArray(raw)) {
      return Buffer.concat(raw.map((chunk) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))))).toString(
        'utf8'
      );
    }
    if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
    throw new WebSocketRpcError('BAD_REQUEST', 'Unsupported websocket payload type.');
  }

  private async executeRequest(request: WebSocketRpcRequest): Promise<any> {
    const params = request.params ?? {};
    switch (request.method) {
      case 'gateway:ping':
        return { pong: true, ts: Date.now() };
      case 'gateway:createSession': {
        const sessionId = await this.gateway.createSession();
        return { sessionId };
      }
      case 'session:list': {
        return { sessions: this.gateway.listSessionSummaries() };
      }
      case 'session:get': {
        const sessionId = this.readStringParam(params, 'sessionId');
        const session = this.gateway.getSessionSnapshot(sessionId);
        if (!session) {
          throw new WebSocketRpcError('NOT_FOUND', `Session not found: ${sessionId}`);
        }
        return { session };
      }
      case 'agent:exportHistory': {
        const bridge = this.options.agentBridge;
        if (!bridge?.exportHistory) {
          throw new WebSocketRpcError('METHOD_NOT_FOUND', 'agent:exportHistory is not available on this websocket gateway.');
        }
        const sessionId = this.readStringParam(params, 'sessionId');
        const mode = params.mode;
        const normalizedMode = mode === 'simple' || mode === 'detailed' ? mode : 'detailed';
        return await bridge.exportHistory(sessionId, normalizedMode);
      }
      case 'agent:getAllChatHistory': {
        const bridge = this.options.agentBridge;
        if (!bridge?.getAllChatHistory) {
          throw new WebSocketRpcError(
            'METHOD_NOT_FOUND',
            'agent:getAllChatHistory is not available on this websocket gateway.'
          );
        }
        return await bridge.getAllChatHistory();
      }
      case 'agent:loadChatSession': {
        const bridge = this.options.agentBridge;
        if (!bridge?.loadChatSession) {
          throw new WebSocketRpcError('METHOD_NOT_FOUND', 'agent:loadChatSession is not available on this websocket gateway.');
        }
        const id = this.readStringParam(params, 'id');
        return await bridge.loadChatSession(id);
      }
      case 'agent:getUiMessages': {
        const bridge = this.options.agentBridge;
        if (!bridge?.getUiMessages) {
          throw new WebSocketRpcError('METHOD_NOT_FOUND', 'agent:getUiMessages is not available on this websocket gateway.');
        }
        const id = this.readStringParam(params, 'id');
        return await bridge.getUiMessages(id);
      }
      case 'terminal:list': {
        if (!this.options.terminalBridge) {
          throw new WebSocketRpcError('METHOD_NOT_FOUND', 'Terminal listing is not available on this websocket gateway.');
        }
        return { terminals: this.options.terminalBridge.listTerminals() };
      }
      case 'terminal:createTab': {
        const bridge = this.options.terminalBridge;
        if (!bridge?.createTab) {
          throw new WebSocketRpcError('METHOD_NOT_FOUND', 'Terminal creation is not available on this websocket gateway.');
        }
        const config = this.readObjectParam(params, 'config');
        const created = await bridge.createTab(config);
        return { id: created.id };
      }
      case 'terminal:write': {
        const bridge = this.options.terminalBridge;
        if (!bridge?.write) {
          throw new WebSocketRpcError('METHOD_NOT_FOUND', 'Terminal write is not available on this websocket gateway.');
        }
        const terminalId = this.readStringParam(params, 'terminalId');
        const data = this.readStringParam(params, 'data');
        await bridge.write(terminalId, data);
        return { ok: true };
      }
      case 'terminal:writePaths': {
        const bridge = this.options.terminalBridge;
        if (!bridge?.writePaths) {
          throw new WebSocketRpcError('METHOD_NOT_FOUND', 'terminal:writePaths is not available on this websocket gateway.');
        }
        const terminalId = this.readStringParam(params, 'terminalId');
        const paths = params.paths;
        if (!Array.isArray(paths) || paths.some((item) => typeof item !== 'string')) {
          throw new WebSocketRpcError('BAD_REQUEST', 'paths must be string array.');
        }
        await bridge.writePaths(terminalId, paths);
        return { ok: true };
      }
      case 'terminal:resize': {
        const bridge = this.options.terminalBridge;
        if (!bridge?.resize) {
          throw new WebSocketRpcError('METHOD_NOT_FOUND', 'Terminal resize is not available on this websocket gateway.');
        }
        const terminalId = this.readStringParam(params, 'terminalId');
        const cols = this.readIntegerParam(params, 'cols', 1, 1000);
        const rows = this.readIntegerParam(params, 'rows', 1, 1000);
        await bridge.resize(terminalId, cols, rows);
        return { ok: true };
      }
      case 'terminal:kill': {
        const bridge = this.options.terminalBridge;
        if (!bridge?.kill) {
          throw new WebSocketRpcError('METHOD_NOT_FOUND', 'Terminal close is not available on this websocket gateway.');
        }
        const terminalId = this.readStringParam(params, 'terminalId');
        await bridge.kill(terminalId);
        return { ok: true };
      }
      case 'terminal:setSelection': {
        const bridge = this.options.terminalBridge;
        if (!bridge?.setSelection) {
          throw new WebSocketRpcError(
            'METHOD_NOT_FOUND',
            'terminal:setSelection is not available on this websocket gateway.'
          );
        }
        const terminalId = this.readStringParam(params, 'terminalId');
        const selectionText = params.selectionText;
        if (typeof selectionText !== 'string') {
          throw new WebSocketRpcError('BAD_REQUEST', 'selectionText must be string.');
        }
        await bridge.setSelection(terminalId, selectionText);
        return { ok: true };
      }
      case 'system:saveTempPaste': {
        const bridge = this.options.systemBridge;
        if (!bridge?.saveTempPaste) {
          throw new WebSocketRpcError('METHOD_NOT_FOUND', 'system:saveTempPaste is not available on this websocket gateway.');
        }
        const content = this.readStringParam(params, 'content');
        const filePath = await bridge.saveTempPaste(content);
        return filePath;
      }
      case 'models:getProfiles': {
        if (!this.options.profileBridge) {
          throw new WebSocketRpcError('METHOD_NOT_FOUND', 'Model profile APIs are not available on this websocket gateway.');
        }
        return this.options.profileBridge.getProfiles();
      }
      case 'models:setActiveProfile': {
        if (!this.options.profileBridge) {
          throw new WebSocketRpcError('METHOD_NOT_FOUND', 'Model profile APIs are not available on this websocket gateway.');
        }
        const profileId = this.readStringParam(params, 'profileId');
        try {
          return this.options.profileBridge.setActiveProfile(profileId);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to set active profile.';
          throw new WebSocketRpcError('BAD_REQUEST', message);
        }
      }
      case 'models:probe': {
        if (!this.options.profileBridge?.probeModel) {
          throw new WebSocketRpcError('METHOD_NOT_FOUND', 'models:probe is not available on this websocket gateway.');
        }
        return await this.options.profileBridge.probeModel(params.model);
      }
      case 'skills:reload': {
        if (!this.options.skillBridge?.reload) {
          throw new WebSocketRpcError('METHOD_NOT_FOUND', 'skills:reload is not available on this websocket gateway.');
        }
        return await this.options.skillBridge.reload();
      }
      case 'skills:getAll': {
        if (!this.options.skillBridge?.getAll) {
          throw new WebSocketRpcError('METHOD_NOT_FOUND', 'skills:getAll is not available on this websocket gateway.');
        }
        return await this.options.skillBridge.getAll();
      }
      case 'skills:getEnabled': {
        if (!this.options.skillBridge?.getEnabled) {
          throw new WebSocketRpcError('METHOD_NOT_FOUND', 'skills:getEnabled is not available on this websocket gateway.');
        }
        return await this.options.skillBridge.getEnabled();
      }
      case 'skills:create': {
        if (!this.options.skillBridge?.create) {
          throw new WebSocketRpcError('METHOD_NOT_FOUND', 'skills:create is not available on this websocket gateway.');
        }
        return await this.options.skillBridge.create();
      }
      case 'skills:delete': {
        if (!this.options.skillBridge?.delete) {
          throw new WebSocketRpcError('METHOD_NOT_FOUND', 'skills:delete is not available on this websocket gateway.');
        }
        const fileName = this.readStringParam(params, 'fileName');
        return await this.options.skillBridge.delete(fileName);
      }
      case 'skills:list': {
        if (!this.options.skillBridge) {
          throw new WebSocketRpcError('METHOD_NOT_FOUND', 'Skill APIs are not available on this websocket gateway.');
        }
        const skills = await this.options.skillBridge.listSkills();
        return { skills };
      }
      case 'skills:setEnabled': {
        if (!this.options.skillBridge?.setSkillEnabled) {
          throw new WebSocketRpcError('METHOD_NOT_FOUND', 'Skill mutation APIs are not available on this websocket gateway.');
        }
        const name = this.readStringParam(params, 'name');
        const enabled = params.enabled;
        if (typeof enabled !== 'boolean') {
          throw new WebSocketRpcError('BAD_REQUEST', 'enabled must be boolean.');
        }
        const skills = await this.options.skillBridge.setSkillEnabled(name, enabled);
        return { skills };
      }
      case 'settings:get': {
        if (!this.options.settingsBridge?.getSettings) {
          throw new WebSocketRpcError('METHOD_NOT_FOUND', 'settings:get is not available on this websocket gateway.');
        }
        return await this.options.settingsBridge.getSettings();
      }
      case 'settings:set': {
        if (!this.options.settingsBridge?.setSettings) {
          throw new WebSocketRpcError('METHOD_NOT_FOUND', 'settings:set is not available on this websocket gateway.');
        }
        const settings = this.readObjectParam(params, 'settings');
        return await this.options.settingsBridge.setSettings(settings);
      }
      case 'settings:getCommandPolicyLists': {
        if (!this.options.commandPolicyBridge?.getLists) {
          throw new WebSocketRpcError(
            'METHOD_NOT_FOUND',
            'settings:getCommandPolicyLists is not available on this websocket gateway.'
          );
        }
        return await this.options.commandPolicyBridge.getLists();
      }
      case 'settings:addCommandPolicyRule': {
        if (!this.options.commandPolicyBridge?.addRule) {
          throw new WebSocketRpcError(
            'METHOD_NOT_FOUND',
            'settings:addCommandPolicyRule is not available on this websocket gateway.'
          );
        }
        const listName = this.readPolicyListNameParam(params, 'listName');
        const rule = this.readStringParam(params, 'rule');
        return await this.options.commandPolicyBridge.addRule(listName, rule);
      }
      case 'settings:deleteCommandPolicyRule': {
        if (!this.options.commandPolicyBridge?.deleteRule) {
          throw new WebSocketRpcError(
            'METHOD_NOT_FOUND',
            'settings:deleteCommandPolicyRule is not available on this websocket gateway.'
          );
        }
        const listName = this.readPolicyListNameParam(params, 'listName');
        const rule = this.readStringParam(params, 'rule');
        return await this.options.commandPolicyBridge.deleteRule(listName, rule);
      }
      case 'tools:reloadMcp': {
        if (!this.options.toolsBridge?.reloadMcp) {
          throw new WebSocketRpcError('METHOD_NOT_FOUND', 'tools:reloadMcp is not available on this websocket gateway.');
        }
        return await this.options.toolsBridge.reloadMcp();
      }
      case 'tools:getMcp': {
        if (!this.options.toolsBridge?.getMcp) {
          throw new WebSocketRpcError('METHOD_NOT_FOUND', 'tools:getMcp is not available on this websocket gateway.');
        }
        return await this.options.toolsBridge.getMcp();
      }
      case 'tools:setMcpEnabled': {
        if (!this.options.toolsBridge?.setMcpEnabled) {
          throw new WebSocketRpcError('METHOD_NOT_FOUND', 'tools:setMcpEnabled is not available on this websocket gateway.');
        }
        const name = this.readStringParam(params, 'name');
        const enabled = params.enabled;
        if (typeof enabled !== 'boolean') {
          throw new WebSocketRpcError('BAD_REQUEST', 'enabled must be boolean.');
        }
        return await this.options.toolsBridge.setMcpEnabled(name, enabled);
      }
      case 'tools:getBuiltIn': {
        if (!this.options.toolsBridge?.getBuiltIn) {
          throw new WebSocketRpcError('METHOD_NOT_FOUND', 'tools:getBuiltIn is not available on this websocket gateway.');
        }
        return await this.options.toolsBridge.getBuiltIn();
      }
      case 'tools:setBuiltInEnabled': {
        if (!this.options.toolsBridge?.setBuiltInEnabled) {
          throw new WebSocketRpcError(
            'METHOD_NOT_FOUND',
            'tools:setBuiltInEnabled is not available on this websocket gateway.'
          );
        }
        const name = this.readStringParam(params, 'name');
        const enabled = params.enabled;
        if (typeof enabled !== 'boolean') {
          throw new WebSocketRpcError('BAD_REQUEST', 'enabled must be boolean.');
        }
        return await this.options.toolsBridge.setBuiltInEnabled(name, enabled);
      }
      case 'agent:startTask': {
        const sessionId = this.readStringParam(params, 'sessionId');
        const userText = this.readStringParam(params, 'userText');
        const options = this.readStartTaskOptions(params.options);
        await this.gateway.dispatchTask(sessionId, userText, options);
        return { ok: true };
      }
      case 'agent:startTaskAsync': {
        const sessionId = this.readStringParam(params, 'sessionId');
        const userText = this.readStringParam(params, 'userText');
        const options = this.readStartTaskOptions(params.options);
        void this.gateway.dispatchTask(sessionId, userText, options).catch((error) => {
          this.logger.error(`[WebSocketGatewayAdapter] Async task failed (session=${sessionId}).`, error);
        });
        return { ok: true };
      }
      case 'agent:stopTask': {
        const sessionId = this.readStringParam(params, 'sessionId');
        await this.gateway.stopTask(sessionId);
        return { ok: true };
      }
      case 'agent:replyMessage': {
        const messageId = this.readStringParam(params, 'messageId');
        const payload = params.payload;
        return this.gateway.submitFeedback(messageId, payload);
      }
      case 'agent:replyCommandApproval': {
        const approvalId = this.readStringParam(params, 'approvalId');
        const decision = this.readStringParam(params, 'decision');
        if (decision !== 'allow' && decision !== 'deny') {
          throw new WebSocketRpcError('BAD_REQUEST', 'decision must be "allow" or "deny".');
        }
        return this.gateway.submitFeedback(approvalId, { decision });
      }
      case 'agent:deleteChatSession': {
        const sessionId = this.readStringParam(params, 'sessionId');
        await this.gateway.deleteChatSession(sessionId);
        return { ok: true };
      }
      case 'agent:renameSession': {
        const sessionId = this.readStringParam(params, 'sessionId');
        const newTitle = this.readStringParam(params, 'newTitle');
        this.gateway.renameSession(sessionId, newTitle);
        return { ok: true };
      }
      case 'agent:rollbackToMessage': {
        const sessionId = this.readStringParam(params, 'sessionId');
        const messageId = this.readStringParam(params, 'messageId');
        return await this.gateway.rollbackSessionToMessage(sessionId, messageId);
      }
      default:
        throw new WebSocketRpcError('UNKNOWN_METHOD', `Unsupported websocket method: ${request.method}`);
    }
  }

  private readStringParam(params: Record<string, any>, name: string): string {
    const value = params[name];
    if (typeof value !== 'string' || value.length === 0) {
      throw new WebSocketRpcError('BAD_REQUEST', `Missing or invalid parameter: ${name}`);
    }
    return value;
  }

  private readIntegerParam(params: Record<string, any>, name: string, min: number, max: number): number {
    const value = params[name];
    if (!Number.isInteger(value)) {
      throw new WebSocketRpcError('BAD_REQUEST', `Missing or invalid parameter: ${name}`);
    }
    if (value < min || value > max) {
      throw new WebSocketRpcError('BAD_REQUEST', `Parameter out of range: ${name}`);
    }
    return value;
  }

  private readObjectParam(params: Record<string, any>, name: string): Record<string, any> {
    const value = params[name];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new WebSocketRpcError('BAD_REQUEST', `Missing or invalid parameter: ${name}`);
    }
    return value as Record<string, any>;
  }

  private readPolicyListNameParam(
    params: Record<string, any>,
    name: string
  ): 'allowlist' | 'denylist' | 'asklist' {
    const value = params[name];
    if (value !== 'allowlist' && value !== 'denylist' && value !== 'asklist') {
      throw new WebSocketRpcError('BAD_REQUEST', `${name} must be one of allowlist|denylist|asklist.`);
    }
    return value;
  }

  private readStartTaskOptions(raw: unknown): StartTaskOptions | undefined {
    if (!raw) return undefined;
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new WebSocketRpcError('BAD_REQUEST', 'Invalid start task options.');
    }
    const options = raw as StartTaskOptions;
    if (options.startMode && options.startMode !== 'normal' && options.startMode !== 'inserted') {
      throw new WebSocketRpcError('BAD_REQUEST', 'options.startMode must be "normal" or "inserted".');
    }
    return options;
  }

  private normalizeRpcError(error: unknown): WebSocketRpcError {
    if (error instanceof WebSocketRpcError) return error;
    if (error instanceof Error) return new WebSocketRpcError('INTERNAL_ERROR', error.message);
    return new WebSocketRpcError('INTERNAL_ERROR', 'Unexpected websocket adapter error.');
  }

  private sendRpcSuccess(socket: IWebSocketConnectionLike, id: string, result: unknown): void {
    this.safeSocketSend(socket, {
      type: 'gateway:response',
      id,
      ok: true,
      result
    });
  }

  private sendRpcFailure(socket: IWebSocketConnectionLike, id: string, code: string, message: string): void {
    this.safeSocketSend(socket, {
      type: 'gateway:response',
      id,
      ok: false,
      error: { code, message }
    });
  }

  private safeSocketSend(socket: IWebSocketConnectionLike, payload: Record<string, any>): void {
    try {
      socket.send(JSON.stringify(payload));
    } catch (error) {
      this.logger.warn('[WebSocketGatewayAdapter] Failed to send RPC response.', error);
    }
  }
}
