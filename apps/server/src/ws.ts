import { createHash } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
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
  private server: Server;
  private readonly connections = new Set<WebSocketConnection>();

  constructor(private readonly options: WsServerOptions) {
    super();
    this.server = createServer((socket) => this.handleSocket(socket));
  }

  listen(port: number, host = "127.0.0.1"): Promise<void> {
    return new Promise((resolve) => this.server.listen(port, host, () => resolve()));
  }

  close(): void {
    for (const connection of this.connections) connection.close();
    this.server.close();
  }

  private handleSocket(socket: Socket): void {
    let handshakeDone = false;
    let connection: WebSocketConnection | null = null;
    let buffer: Buffer = Buffer.alloc(0);

    socket.on("data", (chunk: Buffer) => {
      if (!handshakeDone) {
        buffer = Buffer.concat([buffer, chunk]);
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;
        const header = buffer.subarray(0, headerEnd).toString("utf-8");
        const rest = buffer.subarray(headerEnd + 4);
        buffer = Buffer.alloc(0);
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
        handshakeDone = true;
        connection = new WebSocketConnection(socket);
        this.connections.add(connection);
        buffer = rest;
        if (buffer.length === 0) return;
      } else {
        buffer = Buffer.concat([buffer, chunk]);
      }

      let frame = decodeFrame(buffer);
      while (frame) {
        if (frame.opcode === 0x8) {
          connection?.close();
          return;
        }
        if (frame.opcode === 0x1) {
          try {
            const message = JSON.parse(frame.payload.toString("utf-8")) as WsMessage;
            if (connection) connection.enqueue(message, this.options.onMessage);
          } catch {
            // 忽略无法解析的消息。
          }
        }
        buffer = frame.rest;
        frame = decodeFrame(buffer);
      }
    });

    socket.on("close", () => {
      if (connection) {
        connection.readyState = "closed";
        this.connections.delete(connection);
        this.options.onClose(connection);
      }
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
