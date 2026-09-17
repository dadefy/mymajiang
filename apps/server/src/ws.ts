import { createHash } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import type { IncomingMessage } from "node:http";
import { EventEmitter } from "node:events";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface WsMessage {
  type: string;
  [key: string]: unknown;
}

export class WebSocketConnection {
  readyState: "open" | "closed" = "open";
  userId?: string;
  roomId?: string;
  private messageQueue: Promise<void> = Promise.resolve();

  constructor(readonly socket: Socket) {}

  send(payload: object): void {
    if (this.readyState !== "open") return;
    const data = Buffer.from(JSON.stringify(payload), "utf-8");
    const header = frameHeader(data.length);
    this.socket.write(Buffer.concat([header, data]));
  }

  close(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.socket.end();
  }

  enqueue(message: WsMessage, handler: WsServerOptions["onMessage"]): void {
    this.messageQueue = this.messageQueue
      .then(() => handler(this, message))
      .catch(() => undefined);
  }
}

export interface WsServerOptions {
  onMessage: (connection: WebSocketConnection, message: WsMessage) => void | Promise<void>;
  onClose: (connection: WebSocketConnection) => void;
}

/** 极简 WebSocket 服务端：只支持文本帧（客户端发给服务端的消息必须 UTF-8、未分片）。 */
export class WebSocketServer extends EventEmitter {
  private readonly standalone: Server | null;
  private readonly connections = new Set<WebSocketConnection>();
  /**
   * 由实时层挂上的"立即把所有进行中牌局的快照写盘"。
   *
   * 存在的唯一理由：牌局快照平时按 2 秒节流合并写，而进程收到 SIGTERM 时会立刻退出，
   * 那个悬挂的延迟定时器**永远不会到点**。没有这个钩子，一次正常重启就会丢掉最后约 2 秒的操作。
   * 它补的是"最后一次"，**不替代**运行期间的正常持久化。
   */
  flushRoundStates?: () => void;

  constructor(private readonly options: WsServerOptions, mode: "standalone" | "attached" = "standalone") {
    super();
    this.standalone = mode === "standalone" ? createServer((socket) => this.handleSocket(socket)) : null;
  }

  /** 独立监听一个端口。测试与非共用端口的部署用。 */
  listen(port: number, host = "127.0.0.1"): Promise<void> {
    if (!this.standalone) throw new Error("This WebSocket server is attached to an HTTP server");
    return new Promise((resolve) => this.standalone!.listen(port, host, () => resolve()));
  }

  /**
   * 接管一个来自 HTTP 服务的 `upgrade` 事件。
   *
   * 与独立监听的区别：握手请求已经由 HTTP 服务解析好了，这里只负责算 accept 并接管连接。
   * 这样实时通道与 HTTP **共用同一个端口** —— 对只给一个公网入口的部署（内网穿透、
   * 反向代理）是必需的：浏览器在 HTTPS 页面上会拦截 `ws://`，只能用 `wss://`，
   * 而 `wss://` 需要 TLS 终止点在同一个入口上。
   *
   * `head` 是 HTTP 服务已经读出来、但还没交给我们的那部分字节，必须当作连接的起始数据。
   */
  handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string" || !key) {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1").update(key + WEBSOCKET_GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    this.attachConnection(socket, head);
  }

  close(): void {
    for (const connection of this.connections) connection.close();
    this.standalone?.close();
  }

  private handleSocket(socket: Socket): void {
    let buffer: Buffer = Buffer.alloc(0);

    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = buffer.subarray(0, headerEnd).toString("utf-8");
      const rest = buffer.subarray(headerEnd + 4);
      const key = /^sec-websocket-key:\s*(.+)$/im.exec(header)?.[1]?.trim();
      if (!key) {
        socket.destroy();
        return;
      }
      const accept = createHash("sha1").update(key + WEBSOCKET_GUID).digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      socket.removeAllListeners("data");
      this.attachConnection(socket, rest);
    });
  }

  /** 握手之后的公共部分：接帧、分发消息、处理关闭。 */
  private attachConnection(socket: Socket, initial: Buffer): void {
    const connection = new WebSocketConnection(socket);
    this.connections.add(connection);
    let buffer = initial;

    const consume = (): void => {
      let frame = decodeFrame(buffer);
      while (frame) {
        if (frame.opcode === 0x8) {
          connection.close();
          return;
        }
        if (frame.opcode === 0x1) {
          try {
            const message = JSON.parse(frame.payload.toString("utf-8")) as WsMessage;
            connection.enqueue(message, this.options.onMessage);
          } catch {
            // 忽略无法解析的消息。
          }
        }
        buffer = frame.rest;
        frame = decodeFrame(buffer);
      }
    };

    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      consume();
    });
    consume();

    socket.on("close", () => {
      if (connection.readyState === "closed" && !this.connections.has(connection)) return;
      connection.readyState = "closed";
      this.connections.delete(connection);
      this.options.onClose(connection);
    });

    socket.on("error", () => {
      socket.destroy();
    });
  }
}

function frameHeader(payloadLength: number): Buffer {
  if (payloadLength < 126) return Buffer.from([0x81, payloadLength]);
  if (payloadLength < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payloadLength, 2);
    return header;
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payloadLength), 2);
  return header;
}

function decodeFrame(buffer: Buffer): { opcode: number; payload: Buffer; rest: Buffer } | null {
  if (buffer.length < 2) return null;
  const opcode = buffer[0]! & 0x0f;
  const masked = (buffer[1]! & 0x80) !== 0;
  let length = buffer[1]! & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }

  if (!masked) return null; // 客户端帧必须掩码。
  if (buffer.length < offset + 4) return null;
  const mask = buffer.subarray(offset, offset + 4);
  offset += 4;
  if (buffer.length < offset + length) return null;

  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  for (let index = 0; index < payload.length; index += 1) {
    payload[index] = payload[index]! ^ mask[index % 4]!;
  }
  return { opcode, payload, rest: buffer.subarray(offset + length) };
}
