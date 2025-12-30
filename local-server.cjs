// dark-server.js
// 本地服务器，用于通过WebSocket代理HTTP请求到浏览器环境，并返回结果
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const { EventEmitter } = require('events');
const fetch = require('node-fetch');
const { createProxyMiddleware } = require('http-proxy-middleware');

console.log("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
console.log("!!! LOCAL SERVER (backend/local-server.cjs) is Running !!!");
console.log("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");

// 日志记录器模块
class LoggingService {
  constructor(serviceName = 'ProxyServer') {
    this.serviceName = serviceName;
  }

  _formatMessage(level, message) {
    const timestamp = new Date().toISOString();
    return `[${level}] ${timestamp} [${this.serviceName}] - ${message}`;
  }

  info(message) {
    console.log(this._formatMessage('INFO', message));
  }

  error(message) {
    console.error(this._formatMessage('ERROR', message));
  }

  warn(message) {
    console.warn(this._formatMessage('WARN', message));
  }

  debug(message) {
    console.debug(this._formatMessage('DEBUG', message));
  }
}

// 消息队列实现
class MessageQueue extends EventEmitter {
  constructor(timeoutMs = 600000) {
    super();
    this.messages = [];
    this.waitingResolvers = [];
    this.defaultTimeout = timeoutMs;
    this.closed = false;
  }

  enqueue(message) {
    if (this.closed) return;

    if (this.waitingResolvers.length > 0) {
      const resolver = this.waitingResolvers.shift();
      resolver.resolve(message);
    } else {
      this.messages.push(message);
    }
  }

  async dequeue(timeoutMs = this.defaultTimeout) {
    if (this.closed) {
      throw new Error('Queue is closed');
    }

    return new Promise((resolve, reject) => {
      if (this.messages.length > 0) {
        resolve(this.messages.shift());
        return;
      }

      const resolver = { resolve, reject };
      this.waitingResolvers.push(resolver);

      const timeoutId = setTimeout(() => {
        const index = this.waitingResolvers.indexOf(resolver);
        if (index !== -1) {
          this.waitingResolvers.splice(index, 1);
          reject(new Error('Queue timeout'));
        }
      }, timeoutMs);

      resolver.timeoutId = timeoutId;
    });
  }

  close() {
    this.closed = true;
    this.waitingResolvers.forEach(resolver => {
      clearTimeout(resolver.timeoutId);
      resolver.reject(new Error('Queue closed'));
    });
    this.waitingResolvers = [];
    this.messages = [];
  }
}

// WebSocket连接管理器
class ConnectionRegistry extends EventEmitter {
  constructor(logger) {
    super();
    this.logger = logger;
    this.connections = new Set();
    this.messageQueues = new Map();
  }

  addConnection(websocket, clientInfo) {
    this.connections.add(websocket);
    this.logger.info(`新客户端连接: ${clientInfo.address}`);

    websocket.on('message', (data) => {
      this._handleIncomingMessage(data.toString());
    });

    websocket.on('close', () => {
      this._removeConnection(websocket);
    });

    websocket.on('error', (error) => {
      this.logger.error(`WebSocket连接错误: ${error.message}`);
    });

    this.emit('connectionAdded', websocket);
  }

  _removeConnection(websocket) {
    this.connections.delete(websocket);
    this.logger.info('客户端连接断开');

    // 关闭所有相关的消息队列
    this.messageQueues.forEach(queue => queue.close());
    this.messageQueues.clear();

    this.emit('connectionRemoved', websocket);
  }

  _handleIncomingMessage(messageData) {
    try {
      const parsedMessage = JSON.parse(messageData);
      const requestId = parsedMessage.request_id;

      if (!requestId) {
        this.logger.warn('收到无效消息：缺少request_id');
        return;
      }

      const queue = this.messageQueues.get(requestId);
      if (queue) {
        this._routeMessage(parsedMessage, queue);
      } else {
        this.logger.warn(`收到未知请求ID的消息: ${requestId}`);
      }
    } catch (error) {
      this.logger.error('解析WebSocket消息失败');
    }
  }

  _routeMessage(message, queue) {
    const { event_type } = message;

    switch (event_type) {
      case 'response_headers':
      case 'chunk':
      case 'error':
        queue.enqueue(message);
        break;
      case 'stream_close':
        queue.enqueue({ type: 'STREAM_END' });
        break;
      default:
        this.logger.warn(`未知的事件类型: ${event_type}`);
    }
  }

  hasActiveConnections() {
    return this.connections.size > 0;
  }

  getFirstConnection() {
    return this.connections.values().next().value;
  }

  createMessageQueue(requestId) {
    const queue = new MessageQueue();
    this.messageQueues.set(requestId, queue);
    return queue;
  }

  removeMessageQueue(requestId) {
    const queue = this.messageQueues.get(requestId);
    if (queue) {
      queue.close();
      this.messageQueues.delete(requestId);
    }
  }
}

// 请求处理器
class RequestHandler {
  constructor(connectionRegistry, logger, config) {
    this.connectionRegistry = connectionRegistry;
    this.logger = logger;
    this.config = config || { httpPort: 8889, host: '127.0.0.1' };
  }

  async processRequest(req, res) {
    // 1. 优先处理 CORS OPTIONS 预检请求，直接返回 200
    if (req.method === 'OPTIONS') {
      res.status(200).end();
      return;
    }

    this.logger.info(`处理请求: ${req.method} ${req.url} (Original: ${req.originalUrl}) Type: ${req.get('content-type')}`);

    // 3. 对于其他请求，继续使用现有的 WebSocket "回弹" 逻辑
    if (!this.connectionRegistry.hasActiveConnections()) {
      return this._sendErrorResponse(res, 503, '没有可用的浏览器连接');
    }

    const bodyChunks = [];
    req.on('data', chunk => {
      bodyChunks.push(chunk);
    });

    req.on('end', async () => {
      const body = Buffer.concat(bodyChunks);
      const body_b64 = body.toString('base64');
      const requestId = this._generateRequestId();

      const requestData = {
        path: req.path,
        url: req.originalUrl || req.url, // Pass original URL (path + query)
        method: req.method,
        headers: req.headers,
        query_params: req.query,
        body_b64: body_b64,
        request_id: requestId
      };

      const messageQueue = this.connectionRegistry.createMessageQueue(requestId);

      try {
        await this._forwardRequest(requestData);
        await this._handleResponse(messageQueue, res);
      } catch (error) {
        this._handleRequestError(error, res);
      } finally {
        this.connectionRegistry.removeMessageQueue(requestId);
      }
    });
  }

  _generateRequestId() {
    return `${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }

  _buildProxyRequest(req, requestId) {
    let requestBody = '';
    let isBase64 = false;

    if (req.body) {
      if (typeof req.body === 'string') {
        requestBody = req.body;
      } else if (Buffer.isBuffer(req.body)) {
        requestBody = req.body.toString('base64');
        isBase64 = true;
      } else {
        requestBody = JSON.stringify(req.body);
      }
    }

    return {
      path: req.path,
      url: req.originalUrl || req.url, // Pass original URL (path + query)
      method: req.method,
      headers: req.headers,
      query_params: req.query,
      body: requestBody,
      isBase64: isBase64,
      request_id: requestId
    };
  }

  async _forwardRequest(proxyRequest) {
    const connection = this.connectionRegistry.getFirstConnection();
    connection.send(JSON.stringify(proxyRequest));
  }

  async _handleResponse(messageQueue, res) {
    // 等待响应头
    const headerMessage = await messageQueue.dequeue();

    if (headerMessage.event_type === 'error') {
      return this._sendErrorResponse(res, headerMessage.status || 500, headerMessage.message);
    }

    // 设置响应头
    this._setResponseHeaders(res, headerMessage);

    // 处理流式数据
    await this._streamResponseData(messageQueue, res);
  }

  _setResponseHeaders(res, headerMessage) {
    res.status(headerMessage.status || 200);

    const headers = headerMessage.headers || {};

    // 需要过滤掉可能引起 CORS 冲突的头部
    const forbiddenHeaders = ['access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers'];

    Object.entries(headers).forEach(([name, value]) => {
      if (!forbiddenHeaders.includes(name.toLowerCase())) {
        // 特殊处理 upload url，将其重定向回本地代理
        if (name.toLowerCase() === 'x-goog-upload-url') {
          try {
            const originalUrl = new URL(value);
            // 构造本地代理 URL
            // originalUrl.pathname contains /upload/v1beta/files...
            const newUrl = `http://${this.config.host}:${this.config.httpPort}${originalUrl.pathname}${originalUrl.search}`;
            res.set(name, newUrl);
          } catch (e) {
            // 如果解析失败，保留原值
            res.set(name, value);
          }
        } else {
          res.set(name, value);
        }
      }
    });
  }

  async _streamResponseData(messageQueue, res) {
    while (true) {
      try {
        const dataMessage = await messageQueue.dequeue();

        if (dataMessage.type === 'STREAM_END') {
          break;
        }

        if (dataMessage.data) {
          res.write(dataMessage.data);
        }
      } catch (error) {
        if (error.message === 'Queue timeout') {
          // 如果是 SSE 保持连接
          const contentType = res.get('Content-Type') || '';
          if (contentType.includes('text/event-stream')) {
            res.write(': keepalive\n\n');
          } else {
            break;
          }
        } else {
          throw error;
        }
      }
    }

    res.end();
  }

  _handleRequestError(error, res) {
    // 防止在响应已经发送的情况下报错
    if (res.headersSent) {
      res.end();
      return;
    }

    if (error.message === 'Queue timeout') {
      this._sendErrorResponse(res, 504, '请求超时');
    } else {
      this.logger.error(`请求处理错误: ${error.message}`);
      this._sendErrorResponse(res, 500, `代理错误: ${error.message}`);
    }
  }

  _sendErrorResponse(res, status, message) {
    res.status(status).send(message);
  }
}

// 主服务器类
class ProxyServerSystem extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = {
      httpPort: 8889,
      wsPort: 9998,
      host: '127.0.0.1',
      ...config
    };

    this.logger = new LoggingService('ProxyServer');
    this.connectionRegistry = new ConnectionRegistry(this.logger);
    this.requestHandler = new RequestHandler(this.connectionRegistry, this.logger, this.config);

    this.httpServer = null;
    this.wsServer = null;
  }

  async start() {
    try {
      await this._startHttpServer();
      await this._startWebSocketServer();

      this.logger.info('代理服务器系统启动完成');
      this.emit('started');
    } catch (error) {
      this.logger.error(`启动失败: ${error.message}`);
      this.emit('error', error);
      throw error;
    }
  }

  async _startHttpServer() {
    const app = this._createExpressApp();
    this.httpServer = http.createServer(app);

    return new Promise((resolve) => {
      this.httpServer.listen(this.config.httpPort, this.config.host, () => {
        this.logger.info(`HTTP服务器启动: http://${this.config.host}:${this.config.httpPort}`);
        resolve();
      });
    });
  }

  _createExpressApp() {
    const app = express();

    // 1. 强制 CORS 中间件：使用反射式 CORS 策略以支持所有 headers
    app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');

      // 反射客户端请求的 Headers，解决 "Request header field ... is not allowed" 问题
      const requestHeaders = req.headers['access-control-request-headers'];
      if (requestHeaders) {
        res.header('Access-Control-Allow-Headers', requestHeaders);
      } else {
        res.header('Access-Control-Allow-Headers', '*');
      }

      // 暴露所有常用 Headers，包括上传相关的
      res.header('Access-Control-Expose-Headers', '*');
      res.header('Access-Control-Expose-Headers', 'x-goog-upload-url, x-goog-upload-status, x-goog-upload-chunk-granularity, x-goog-upload-control-url, x-goog-upload-command, x-goog-upload-content-type, x-goog-upload-protocol, x-goog-upload-file-name, x-goog-upload-offset, date, content-type, content-length');

      next();
    });

    // 中间件配置
    // Body-parser middleware removed to enable raw body capture for Base64 encoding.

    // 静态文件服务
    const distPath = path.join(__dirname, '../dist');
    app.use(express.static(distPath));

    // 所有其他路由处理
    app.all(/(.*)/, (req, res) => {
      // 1. 如果是 API 请求 (通常以 /v1, /upload 开头，或者是 POST/PUT 等非 GET 请求)，交给代理处理
      // 或者是带有查询参数的请求(往往是 API)
      const isApiRequest = req.path.startsWith('/v1') ||
        req.path.startsWith('/upload') ||
        req.method !== 'GET' ||
        Object.keys(req.query).length > 0;

      if (isApiRequest) {
        return this.requestHandler.processRequest(req, res);
      }

      // 2. 对于非 API 的 GET 请求
      // 如果环境变量中有 VITE_DEV_SERVER_URL，说明是开发模式，将请求转发给 Vite
      if (process.env.VITE_DEV_SERVER_URL) {
        if (req.method === 'GET' || req.method === 'HEAD') {
          this.logger.debug(`Proxying to Vite: ${req.url}`);
          return createProxyMiddleware({
            target: process.env.VITE_DEV_SERVER_URL,
            changeOrigin: true,
            ws: true,
            logLevel: 'silent' // Avoid double logging
          })(req, res, next);
        }
      }

      // 3. 如果是生产模式（没有 VITE_DEV_SERVER_URL），且 accept html，则返回 index.html (SPA Fallback)
      if (req.accepts('html')) {
        return res.sendFile(path.join(distPath, 'index.html'));
      }

      // 3. 其他情况交给代理处理 (万一有漏网的 API)
      return this.requestHandler.processRequest(req, res);
    });

    return app;
  }

  async _startWebSocketServer() {
    this.wsServer = new WebSocket.Server({
      port: this.config.wsPort,
      host: this.config.host
    });

    this.wsServer.on('connection', (ws, req) => {
      this.connectionRegistry.addConnection(ws, {
        address: req.socket.remoteAddress
      });
    });

    this.logger.info(`WebSocket服务器启动: ws://${this.config.host}:${this.config.wsPort}`);
  }
}

// 启动函数
async function initializeServer() {
  const serverSystem = new ProxyServerSystem();

  try {
    await serverSystem.start();
  } catch (error) {
    console.error('服务器启动失败:', error.message);
    process.exit(1);
  }
}

// 模块导出和启动
if (require.main === module) {
  initializeServer();
}

module.exports = { ProxyServerSystem, initializeServer };
