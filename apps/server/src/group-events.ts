import type { GroupMessageType } from "@mianyang-mahjong/domain";

/** 群消息对外的样子：撤回后内容会被替换，原始内容不出网。 */
export interface GroupMessageView {
  messageId: string;
  senderId: string;
  /**
   * 发送者昵称，由 API 层用账号仓库补齐。
   *
   * 消息本身只带 `senderId`（10 位数字），群聊页面要显示「谁在说话」就得有昵称。
   * 与战绩接口补玩家昵称是同一套做法（见 PROJECT_STATUS 4.11）。
   */
  senderNickname?: string;
  sentAt: Date;
  type: GroupMessageType;
  content: string;
  voiceSeconds?: number;
  recalledAt: Date | null;
}

/**
 * 群聊里值得实时推给在线成员的变化。
 *
 * 只推「内容变化」：发消息、撤回、群公告与全员禁言开关。成员管理这类操作走 REST 的返回值即可，
 * 两个例外是被移出群的成员（`member-removed`）和群被解散（`dissolved`）——
 * 这两种情况下连接必须立刻停止接收，否则会一直挂着一个已经没有意义的订阅。
 */
export type GroupEvent =
  | { type: "message"; groupId: string; message: GroupMessageView }
  | { type: "recalled"; groupId: string; message: GroupMessageView }
  | { type: "updated"; groupId: string; notice?: string; allMuted?: boolean }
  | { type: "member-removed"; groupId: string; userId: string }
  | { type: "dissolved"; groupId: string };

export type GroupEventListener = (event: GroupEvent) => void;

/**
 * REST 层与实时层之间的桥。
 *
 * 群消息是通过 REST 写进来的，而在线成员要立刻看到，所以写成功之后在这里广播一次。
 * 用事件总线而不是让 `app.ts` 直接调用 WebSocket 服务：`app` 比 WebSocket 服务先创建，
 * 而且路由层不该知道有没有实时通道。
 */
export interface GroupEventBus {
  publish(event: GroupEvent): void;
  /** 返回取消订阅的函数。 */
  subscribe(listener: GroupEventListener): () => void;
}

export class InMemoryGroupEventBus implements GroupEventBus {
  private readonly listeners = new Set<GroupEventListener>();

  publish(event: GroupEvent): void {
    // 复制一份再遍历：监听器在回调里退订也不会打乱这次广播。
    for (const listener of [...this.listeners]) listener(event);
  }

  subscribe(listener: GroupEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
