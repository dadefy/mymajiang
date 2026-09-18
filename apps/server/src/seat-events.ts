/**
 * 座位在场状态（暂离 / 回到牌桌）变化的**通知**事件。
 *
 * 与 `GroupEventBus` 同一个用途：REST 层写完状态之后，实时层要把这件事告诉房间里的人。
 * 具体场景只有一个 —— `POST /v1/rooms/:roomId/seat/presence`。
 * 暂离必须走 REST 而不是 WebSocket，因为这个信号得在**关掉 socket 之前**送出去；
 * 而"另外三家要立刻看到『暂离』"这件事只有实时层能办，两者之间就需要这座桥。
 *
 * ⚠️ 事件里**不带状态快照**，只带"谁在哪一间房变了"。
 * 权威状态只有一个来源（域层的 `MatchRoom`），实时层收到通知后回房间重新读一次再广播。
 * 带上快照就会出现"事件里的值"和"房间里的值"不一致的情况，而这种不一致没法排查。
 *
 * 为什么不让 `app.ts` 直接调用 WebSocket 服务：`app` 比 WebSocket 服务先创建，
 * 而且路由层不该知道有没有实时通道 —— 与群聊事件完全一致的理由。
 */
export interface SeatEvent {
  roomId: string;
  /** 状态发生变化的那一**座**的主人。实时层据此定位座位并重排自动定时器。 */
  userId: string;
  /**
   * 对局已在 REST 层收尾（三票解散 `finalize` 完毕，积分已结、终态已落库）：
   * 实时层**不要再读房间广播对局帧**，只负责摘除对局、撤掉定时器、
   * 给还连着的客户端补发 `match-finished`（终局载荷用房间里现成的 `result`）。
   */
  matchClosed?: boolean;
}

export type SeatEventListener = (event: SeatEvent) => void;

export interface SeatEventBus {
  publish(event: SeatEvent): void;
  /** 返回取消订阅的函数。 */
  subscribe(listener: SeatEventListener): () => void;
}

export class InMemorySeatEventBus implements SeatEventBus {
  private readonly listeners = new Set<SeatEventListener>();

  publish(event: SeatEvent): void {
    // 复制一份再遍历：监听器在回调里退订也不会打乱这次广播。
    for (const listener of [...this.listeners]) listener(event);
  }

  subscribe(listener: SeatEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
