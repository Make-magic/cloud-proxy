
// cloud-server.tsx
// version 2.2
// Build https://aistudio.google.com/apps/drive/1twd-9p3IDHB5TZ5_ytjec4aOJLOgZIt4?showAssistant=true&showPreview=true
// 浏览器端代理系统，通过WebSocket与本地服务器通信，处理HTTP请求并返回响应

console.log("%c!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!", "color: red; font-size: 20px; font-weight: bold;");
console.log("%c!!! CLOUD SERVER (backend/cloud-server.tsx) HAS BEEN UPDATED !!!", "color: red; font-size: 20px; font-weight: bold;");
console.log("%c!!! IF YOU SEE THIS, THE CODE FIX IS ACTIVE !!!", "color: red; font-size: 20px; font-weight: bold;");
console.log("%c!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!", "color: red; font-size: 20px; font-weight: bold;");

// 调试输出模块
const Logger = {
  enabled: true,
  
  output(...messages: any[]) {
    if (!this.enabled) return;
    
    const timestamp = this._getTimestamp();
    const logElement = document.createElement('div');
    logElement.textContent = `[${timestamp}] ${messages.join(' ')}`;
    document.body.appendChild(logElement);
  },
  
  _getTimestamp() {
    const now = new Date();
    const time = now.toLocaleTimeString('zh-CN', { hour12: false });
    const ms = now.getMilliseconds().toString().padStart(3, '0');
    return `${time}.${ms}`;
  }
};

function b64toBlob(b64Data: string, contentType = '', sliceSize = 512): Blob {
  const byteCharacters = atob(b64Data);
  const byteArrays = [];
  for (let offset = 0; offset < byteCharacters.length; offset += sliceSize) {
    const slice = byteCharacters.slice(offset, offset + sliceSize);
    const byteNumbers = new Array(slice.length);
    for (let i = 0; i < slice.length; i++) {
      byteNumbers[i] = slice.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    byteArrays.push(byteArray);
  }
  return new Blob(byteArrays, { type: contentType });
}

// WebSocket连接管理器
class ConnectionManager extends EventTarget {
  endpoint: string;
  socket: WebSocket | null;
  isConnected: boolean;
  reconnectDelay: number;
  maxReconnectAttempts: number;
  reconnectAttempts: number;

  constructor(endpoint = 'ws://127.0.0.1:9998') {
    super();
    this.endpoint = endpoint;
    this.socket = null;
    this.isConnected = false;
    this.reconnectDelay = 5000;
    this.maxReconnectAttempts = Infinity;
    this.reconnectAttempts = 0;
  }
  
  async establish() {
    if (this.isConnected) {
      Logger.output('[ConnectionManager] 连接已存在');
      return Promise.resolve();
    }
    
    Logger.output('[ConnectionManager] 建立连接:', this.endpoint);
    
    return new Promise<void>((resolve, reject) => {
      this.socket = new WebSocket(this.endpoint);
      
      this.socket.addEventListener('open', () => {
        this.isConnected = true;
        this.reconnectAttempts = 0;
        Logger.output('[ConnectionManager] 连接建立成功');
        this.dispatchEvent(new CustomEvent('connected'));
        resolve();
      });
      
      this.socket.addEventListener('close', () => {
        this.isConnected = false;
        Logger.output('[ConnectionManager] 连接断开，准备重连');
        this.dispatchEvent(new CustomEvent('disconnected'));
        this._scheduleReconnect();
      });
      
      this.socket.addEventListener('error', (error) => {
        Logger.output('[ConnectionManager] 连接错误:', error);
        this.dispatchEvent(new CustomEvent('error', { detail: error }));
        if (!this.isConnected) reject(error);
      });
      
      this.socket.addEventListener('message', (event) => {
        this.dispatchEvent(new CustomEvent('message', { detail: event.data }));
      });
    });
  }
  
  transmit(data: any) {
    if (!this.isConnected || !this.socket) {
      Logger.output('[ConnectionManager] 无法发送数据：连接未建立');
      return false;
    }
    
    this.socket.send(JSON.stringify(data));
    return true;
  }
  
  _scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      Logger.output('[ConnectionManager] 达到最大重连次数');
      return;
    }
    
    this.reconnectAttempts++;
    setTimeout(() => {
      Logger.output(`[ConnectionManager] 重连尝试 ${this.reconnectAttempts}`);
      this.establish().catch(() => {});
    }, this.reconnectDelay);
  }
}

// HTTP请求处理器
class RequestProcessor {
  activeOperations: Map<string, AbortController>;
  targetDomain: string;

  constructor() {
    this.activeOperations = new Map();
    this.targetDomain = 'generativelanguage.googleapis.com';
  }
  
  async execute(requestSpec: any, operationId: string) {
    Logger.output('[RequestProcessor] 执行请求:', requestSpec.method, requestSpec.url || requestSpec.path);
    
    try {
      const abortController = new AbortController();
      this.activeOperations.set(operationId, abortController);
      
      const requestUrl = this._constructUrl(requestSpec);
      const requestConfig = this._buildRequestConfig(requestSpec, abortController.signal);
      
      const response = await fetch(requestUrl, requestConfig);
      
      // Note: We don't throw on !response.ok here to allow the proxy to pass back 4xx/5xx responses intact
      
      return response;
    } catch (error: any) {
      Logger.output('[RequestProcessor] 请求执行失败:', error.message);
      throw error;
    } finally {
      this.activeOperations.delete(operationId);
    }
  }
  
  cancelOperation(operationId: string) {
    const controller = this.activeOperations.get(operationId);
    if (controller) {
      controller.abort();
      this.activeOperations.delete(operationId);
      Logger.output('[RequestProcessor] 操作已取消:', operationId);
    }
  }
  
  cancelAllOperations() {
    this.activeOperations.forEach((controller, id) => {
      controller.abort();
      Logger.output('[RequestProcessor] 取消操作:', id);
    });
    this.activeOperations.clear();
  }
  
  _constructUrl(requestSpec: any) {
    let pathAndQuery = requestSpec.url;

    // 如果没有提供 url，尝试使用 path 和 query_params 重构
    if (!pathAndQuery) {
        const pathSegment = requestSpec.path || '';
        const queryParams = new URLSearchParams(requestSpec.query_params);
        const queryString = queryParams.toString();
        pathAndQuery = `${pathSegment}${queryString ? '?' + queryString : ''}`;
    }

    // 处理可能是绝对 URL 的情况 (e.g. http://localhost:8889/upload...)
    // 我们只需要 pathname 和 search 部分
    if (pathAndQuery.match(/^https?:\/\//)) {
        try {
            const urlObj = new URL(pathAndQuery);
            const originalUrl = pathAndQuery;
            pathAndQuery = urlObj.pathname + urlObj.search;
            Logger.output(`[RequestProcessor] 重写绝对URL: ${originalUrl} -> ${pathAndQuery}`);
        } catch (e: any) {
            Logger.output('[RequestProcessor] URL解析警告:', e.message);
            // Fallback: 如果解析失败，尝试简单截取
        }
    }

    // 动态提取目标域名 (__proxy_host__)
    let targetHost = this.targetDomain;
    if (pathAndQuery.includes('__proxy_host__=')) {
        try {
            // 使用伪协议来解析相对路径中的 query params
            const tempUrl = new URL(pathAndQuery, 'http://dummy');
            const params = tempUrl.searchParams;
            if (params.has('__proxy_host__')) {
                targetHost = params.get('__proxy_host__');
                params.delete('__proxy_host__');
                // 重构 pathAndQuery (pathname + search)
                pathAndQuery = tempUrl.pathname + tempUrl.search;
                Logger.output(`[RequestProcessor] 动态切换目标域名: ${targetHost}`);
            }
        } catch (e: any) {
             Logger.output('[RequestProcessor] 解析代理Host失败:', e.message);
        }
    }

    // 确保不以 / 开头（因为我们后面会加 /），并且移除多余的斜杠
    // 使用 replace(/^\/+/, '') 确保移除开头的所有斜杠，防止生成 //upload/... 这样的路径
    let cleanPath = pathAndQuery.replace(/^\/+/, '');
    
    const method = requestSpec.method ? requestSpec.method.toUpperCase() : 'GET';
    
    if (this.targetDomain.includes('generativelanguage')) {
         // 1. 修复常见的路径重复问题
         // 场景: client: /v1beta/upload/v1beta/files -> cleanPath: v1beta/upload/v1beta/files
         // 目标: upload/v1beta/files
         const uploadMatch = cleanPath.match(/upload\/v1beta\/files/);
         if (uploadMatch) {
             // 提取从 upload/v1beta/files 开始的所有内容
             const index = cleanPath.indexOf('upload/v1beta/files');
             if (index > 0) {
                 const fixedPath = cleanPath.substring(index);
                 Logger.output(`[RequestProcessor] 修正路径(移除前缀): ${cleanPath} -> ${fixedPath}`);
                 cleanPath = fixedPath;
             }
         } 
         // 2. 修复缺少 upload 前缀的问题
         // 场景: client: /v1beta/files (POST) -> cleanPath: v1beta/files
         // 目标: upload/v1beta/files
         else if (method === 'POST' && cleanPath.startsWith('v1beta/files')) {
            cleanPath = 'upload/' + cleanPath;
            Logger.output('[RequestProcessor] 自动补全 Upload 路径:', cleanPath);
         }
    }

    const finalUrl = `https://${targetHost}/${cleanPath}`;
    Logger.output(`[RequestProcessor] URL构造: ${pathAndQuery} -> ${finalUrl}`);
    return finalUrl;
  }
  
  _buildRequestConfig(requestSpec: any, signal: AbortSignal) {
    const config: any = {
      method: requestSpec.method,
      headers: this._sanitizeHeaders(requestSpec.headers),
      signal
    };
    
    if (['POST', 'PUT', 'PATCH'].includes(requestSpec.method) && requestSpec.body != null) {
      // The body is now pre-processed into either a string (JSON) or a Blob.
      // Fetch handles both correctly.
      config.body = requestSpec.body;
    }
    
    return config;
  }
  
  _sanitizeHeaders(headers: any) {
    const sanitized = { ...headers };
    const forbiddenHeaders = [
      'host', 'connection', 'content-length', /* 'origin', */
      'referer', 'user-agent', 'sec-fetch-mode',
      'sec-fetch-site', 'sec-fetch-dest'
    ];
    
    forbiddenHeaders.forEach(header => delete sanitized[header]);
    return sanitized;
  }
}

// 流式响应处理器
class StreamHandler {
  communicator: ConnectionManager;

  constructor(communicator: ConnectionManager) {
    this.communicator = communicator;
  }
  
  async processStream(response: Response, operationId: string, proxyHost?: string) {
    Logger.output('[StreamHandler] 开始处理流式响应');
    
    // 发送响应头信息
    this._transmitHeaders(response, operationId, proxyHost);
    
    if (!response.body) {
        Logger.output('[StreamHandler] 无响应体 (可能是OPTIONS或204)');
        this._transmitStreamEnd(operationId);
        return;
    }

    const reader = response.body.getReader();
    const textDecoder = new TextDecoder();
    
    try {
      while (true) {
        const { done, value } = await reader.read();
        
        if (done) {
          Logger.output('[StreamHandler] 流处理完成');
          this._transmitStreamEnd(operationId);
          break;
        }
        
        const textChunk = textDecoder.decode(value, { stream: true });
        this._transmitChunk(textChunk, operationId);
      }
    } catch (error: any) {
      Logger.output('[StreamHandler] 流处理错误:', error.message);
      throw error;
    }
  }
  
  _transmitHeaders(response: Response, operationId: string, proxyHost?: string) {
    const headerMap: any = {};
    response.headers.forEach((value, key) => {
      // 关键修复：处理文件上传(FILES API)时的重定向URL
      // 将 Google 的绝对 URL 转换为指向本地代理的绝对 URL
      // SDK requires an absolute URL (http://...) to prevent it from using the frontend origin.
      const lowerKey = key.toLowerCase();
      if ((lowerKey === 'location' || lowerKey === 'x-goog-upload-url') && value.includes('googleapis.com')) {
          try {
              const urlObj = new URL(value);
              // Use captured Host from request, or fallback to default 127.0.0.1:8889
              const host = proxyHost || '127.0.0.1:8889';
              
              // 将原始域名作为参数附加，以便后续请求能还原目标域名
              const separator = urlObj.search ? '&' : '?';
              const newSearch = `${urlObj.search}${separator}__proxy_host__=${urlObj.host}`;
              
              // Construct absolute URL: http://127.0.0.1:8889/upload/v1beta/files...
              const newUrl = `http://${host}${urlObj.pathname}${newSearch}`;
              
              headerMap[key] = newUrl;
              Logger.output(`[StreamHandler] 重写Header ${key}: ${value} -> ${headerMap[key]}`);
          } catch (e) {
              headerMap[key] = value;
          }
      } else {
          headerMap[key] = value;
      }
    });
    
    const headerMessage = {
      request_id: operationId,
      event_type: 'response_headers',
      status: response.status,
      headers: headerMap
    };
    
    this.communicator.transmit(headerMessage);
    Logger.output('[StreamHandler] 响应头已传输');
  }
  
  _transmitChunk(chunk: string, operationId: string) {
    const chunkMessage = {
      request_id: operationId,
      event_type: 'chunk',
      data: chunk
    };
    
    this.communicator.transmit(chunkMessage);
  }
  
  _transmitStreamEnd(operationId: string) {
    const endMessage = {
      request_id: operationId,
      event_type: 'stream_close'
    };
    
    this.communicator.transmit(endMessage);
  }
}

// 主代理系统
class ProxySystem extends EventTarget {
  connectionManager: ConnectionManager;
  requestProcessor: RequestProcessor;
  streamHandler: StreamHandler;

  constructor(websocketEndpoint?: string) {
    super();
    this.connectionManager = new ConnectionManager(websocketEndpoint);
    this.requestProcessor = new RequestProcessor();
    this.streamHandler = new StreamHandler(this.connectionManager);
    
    this._setupEventHandlers();
  }
  
  async initialize() {
    Logger.output('[ProxySystem] 系统初始化中...');
    
    try {
      await this.connectionManager.establish();
      Logger.output('[ProxySystem] 系统初始化完成');
      this.dispatchEvent(new CustomEvent('ready'));
    } catch (error: any) {
      Logger.output('[ProxySystem] 系统初始化失败:', error.message);
      this.dispatchEvent(new CustomEvent('error', { detail: error }));
      throw error;
    }
  }
  
  _setupEventHandlers() {
    this.connectionManager.addEventListener('message', (event: any) => {
      this._handleIncomingMessage(event.detail);
    });
    
    this.connectionManager.addEventListener('disconnected', () => {
      this.requestProcessor.cancelAllOperations();
    });
  }
  
  async _handleIncomingMessage(messageData: string) {
    let requestSpec: any = null;
    try {
      requestSpec = JSON.parse(messageData);
      Logger.output('[ProxySystem] 收到请求:', requestSpec.method, requestSpec.path);
      
      const { headers, body_b64 } = requestSpec;

      // 如果 body_b64 存在，说明是文件上传类的请求
      if (body_b64) {
        // 1. 删除 content-length，让浏览器根据 Blob 自动计算
        if (headers) {
            const contentLengthKey = Object.keys(headers).find(k => k.toLowerCase() === 'content-length');
            if (contentLengthKey) {
                delete headers[contentLengthKey];
                Logger.output('[ProxySystem] 删除了 content-length 头部');
            }
        }
        
        // 2. 将 Base64 解码为 Blob
        const contentType = headers?.['content-type'] || '';
        requestSpec.body = b64toBlob(body_b64, contentType);
        
        // 3. 清理不再需要的字段
        delete requestSpec.body_b64;
      }

      await this._processProxyRequest(requestSpec);
    } catch (error: any) {
      Logger.output('[ProxySystem] 消息处理错误:', error.message);
      this._sendErrorResponse(error, requestSpec?.request_id);
    }
  }
  
  async _processProxyRequest(requestSpec: any) {
    const operationId = requestSpec.request_id;
    
    // Extract Host header case-insensitively
    let proxyHost: string | undefined;
    if (requestSpec.headers) {
        const hostKey = Object.keys(requestSpec.headers).find(k => k.toLowerCase() === 'host');
        if (hostKey) proxyHost = requestSpec.headers[hostKey];
    }
    
    try {
      const response = await this.requestProcessor.execute(requestSpec, operationId);
      await this.streamHandler.processStream(response, operationId, proxyHost);
    } catch (error: any) {
      if (error.name === 'AbortError') {
        Logger.output('[ProxySystem] 请求被中止');
      } else {
        this._sendErrorResponse(error, operationId);
      }
    }
  }
  
  _sendErrorResponse(error: any, operationId: string) {
    if (!operationId) {
      Logger.output('[ProxySystem] 无法发送错误响应：缺少操作ID');
      return;
    }
    
    const errorMessage = {
      request_id: operationId,
      event_type: 'error',
      status: 500,
      message: `代理系统错误: ${error.message || '未知错误'}`
    };
    
    this.connectionManager.transmit(errorMessage);
    Logger.output('[ProxySystem] 错误响应已发送');
  }
}

// 系统启动函数
async function initializeProxySystem() {
  const proxySystem = new ProxySystem();
  
  try {
    await proxySystem.initialize();
    console.log('浏览器代理系统已成功启动');
  } catch (error) {
    console.error('代理系统启动失败:', error);
  }
}

// 启动系统
initializeProxySystem();
