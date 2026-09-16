import type { ClientFrame, GroupMessageView, MatchResult, MatchState, RoomResult, ServerFrame } from "./protocol.js";
import type { SocketTransport, SocketTransportFactory } from "./transport.js";

/** 连接断开后的重连节奏：0.5s、1s、2s、4s……封顶 8s。 */
const BACKOFF_MS = [500, 1000, 2000, 4000, 8000] as const;

export type SocketEvent =
  | { kind: "connected"; roomId?: string }
  | { kind: "reconnected" }
  | { kind: "disconnected" }
  | { kind: "game"; state: MatchState }
  | { kind: "actions"; actions: string[] }
  | { kind: "room"; status: string; playerCount: number }
  | { kind: "round-finished"; roundNumber: number; result: RoomResult; nextRoundInMs: number }
  | { kind: "match-finished"; result: MatchResult }
  | { kind: "group-message"; groupId: string; message: GroupMessageView }
  | { kind: "group-message-recalled"; groupId: string; message: GroupMessageView }
  | { kind: "group-updated"; groupId: string; notice?: string; allMuted?: boolean }
  | { kind: "group-removed"; groupId: string }
  | { kind: "group-dissolved"; groupId: string }
  | { kind: "error"; message: string };

function asServerFrame(payload: unknown): ServerFrame | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const type = (payload as { type?: unknown }).type;
  return typeof type === "string" ? ({ ...(payload as object), type } as ServerFrame) : undefined;
}

/**
 * 房间对局与群聊的实时通道。
 *
 * 只做三件事：完成 auth 握手、把服务端帧翻译成带类型的事件、断线后带着状态重连。
 * 重连必须重放两样东西 —— auth 本身，以及退订前订阅过的群，否则恢复连接后收不到群消息。
 */
export class MatchSocket {
  private transport: SocketTransport | null = null;
  /** 取消当前传输的监听；换新连接或彻底关闭时必须先摘掉，否则旧连接的 close 会再次触发重连。 */
  private detachTransport: (() => void) | null = null;
  private readonly listeners = new Set<(event: SocketEvent) => void>();
  private readonly subscribedGroups = new Set<string>();
  private roomId: string | undefined;
  private closed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly options: { url: string; token: string; factory: SocketTransportFactory },
  ) {}

  on(listener: (event: SocketEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 连接并完成 auth 握手。`roomId` 省略时只订阅群聊，不绑房间。 */
  async connect(roomId?: string): Promise<void> {
    this.closed = false;
    this.roomId = roomId;
    // 重连时旧连接多半已经半死；先摘掉它的监听再关掉，避免两条通道同时收发。
    this.detachTransport?.();
    this.detachTransport = null;
    this.transport?.close();
    this.transport = await this.options.factory.connect(this.options.url);
    const offMessage = this.transport.onMessage((payload) => this.dispatch(payload));
    const offClose = this.transport.onClose(() => {
      for (const listener of this.listeners) listener({ kind: "disconnected" });
      this.scheduleReconnect();
    });
    this.detachTransport = () => {
      offMessage();
      offClose();
    };
    // auth 是握手的第一帧；房间与群订阅都在这之后重放。
    this.rawSend({ type: "auth", token: this.options.token, ...(roomId ? { roomId } : {}) });
    for (const groupId of this.subscribedGroups) this.rawSend({ type: "group-subscribe", groupId });
    const reconnected = this.reconnectAttempt > 0;
    this.reconnectAttempt = 0;
    for (const listener of this.listeners) {
      listener(reconnected ? { kind: "reconnected" } : { kind: "connected", ...(roomId ? { roomId } : {}) });
    }
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.detachTransport?.();
    this.detachTransport = null;
    this.transport?.close();
    this.transport = null;
  }

  send(frame: ClientFrame): void {
    this.rawSend(frame);
  }

  subscribeGroup(groupId: string): void {
    this.subscribedGroups.add(groupId);
    this.rawSend({ type: "group-subscribe", groupId });
  }

  unsubscribeGroup(groupId: string): void {
    this.subscribedGroups.delete(groupId);
    this.rawSend({ type: "group-unsubscribe", groupId });
  }

  private rawSend(payload: unknown): void {
    if (!this.transport) throw new Error("Socket is not connected");
    this.transport.send(payload);
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = BACKOFF_MS[Math.min(this.reconnectAttempt, BACKOFF_MS.length - 1)]!;
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.connect(this.roomId).catch(() => this.scheduleReconnect());
    }, delay);
  }

  private dispatch(payload: unknown): void {
    const frame = asServerFrame(payload);
    if (!frame) return;
    for (const listener of this.listeners) {
      switch (frame.type) {
        case "game": listener({ kind: "game", state: frame.state }); break;
        case "actions": listener({ kind: "actions", actions: frame.actions }); break;
        case "room": listener({ kind: "room", status: frame.status, playerCount: frame.playerCount }); break;
        case "round-finished":
          listener({
            kind: "round-finished",
            roundNumber: frame.roundNumber,
            result: frame.result,
            // 老服务端不带这个字段 —— 缺省按「不停留」，倒计时自然不显示。
            nextRoundInMs: frame.nextRoundInMs ?? 0,
          });
          break;
        case "match-finished": listener({ kind: "match-finished", result: frame.result }); break;
        case "group-message": listener({ kind: "group-message", groupId: frame.groupId, message: frame.message }); break;
        case "group-message-recalled":
          listener({ kind: "group-message-recalled", groupId: frame.groupId, message: frame.message });
          break;
        case "group-updated":
          listener({
            kind: "group-updated",
            groupId: frame.groupId,
            ...(frame.notice === undefined ? {} : { notice: frame.notice }),
            ...(frame.allMuted === undefined ? {} : { allMuted: frame.allMuted }),
          });
          break;
        case "group-removed":
          // 服务端已经把订阅撤了，本地也要删掉，否则重连时会向一个不存在的群重新订阅。
          this.subscribedGroups.delete(frame.groupId);
          listener({ kind: "group-removed", groupId: frame.groupId });
          break;
        case "group-dissolved":
          this.subscribedGroups.delete(frame.groupId);
          listener({ kind: "group-dissolved", groupId: frame.groupId });
          break;
        case "error": listener({ kind: "error", message: frame.message }); break;
        case "ready":
        case "group-subscribed":
        case "group-unsubscribed":
          // 握手与订阅回执由 connect()/subscribeGroup() 的调用方关心，这里不向外抛。
          break;
      }
    }
  }
}
