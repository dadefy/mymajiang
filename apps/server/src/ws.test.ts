import { connect, type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "./ws.js";

function encodeClientFrame(payload: string): Buffer {
  const data = Buffer.from(payload, "utf-8");
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  let header: Buffer;
  if (data.length < 126) header = Buffer.from([0x81, 0x80 | data.length]);
  else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  const masked = Buffer.from(data);
  for (let i = 0; i < masked.length; i += 1) masked[i] = masked[i]! ^ mask[i % 4]!;
  return Buffer.concat([header, mask, masked]);
}

describe("ws 协议层", () => {
  it("握手 + 文本帧收发", async () => {
    const received: unknown[] = [];
    const wss = new WebSocketServer({
      onMessage(connection, message) {
        received.push(message);
        connection.send({ type: "echo", value: message.value });
      },
      onClose() {},
    });
    await wss.listen(3601);

    const client = connect({ host: "127.0.0.1", port: 3601 });
    const messages: object[] = [];
    let buffer = Buffer.alloc(0);
    let handshakeDone = false;
    client.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshakeDone) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        buffer = buffer.subarray(end + 4);
        handshakeDone = true;
      }
      // 解析服务端帧
      while (buffer.length >= 2) {
        let length = buffer[1]! & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) break;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) break;
          length = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        if (buffer.length < offset + length) break;
        messages.push(JSON.parse(buffer.subarray(offset, offset + length).toString("utf-8")));
        buffer = buffer.subarray(offset + length);
      }
    });

    await new Promise<void>((resolve) => client.on("connect", () => resolve()));
    const key = Buffer.from("test-key-1234567890").toString("base64");
    client.write(
      "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );

    await new Promise((r) => setTimeout(r, 200));
    client.write(encodeClientFrame(JSON.stringify({ type: "hello", value: 42 })));

    await new Promise((r) => setTimeout(r, 300));
    expect(received).toEqual([{ type: "hello", value: 42 }]);
    expect(messages).toEqual([{ type: "echo", value: 42 }]);

    client.destroy();
    wss.close();
  });
});
