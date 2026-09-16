import type { GroupDetail, GroupMessageView } from "@mianyang-mahjong/client";

/**
 * 群聊消息行的展示模型。
 *
 * 与 `table-model.ts` 同一个思路：这里只做纯计算，页面拿到结果直接贴节点。
 * 时间格式、能不能撤回、正文该显示成什么，都不写在渲染代码里 —— 那样没法测。
 */

/**
 * 普通用户撤回自己消息的时间窗。
 *
 * 与服务端的 `GROUP_LIMITS.recallWindowMinutes`（2 分钟）一致。
 * **权威判定在服务端**：这里只决定「要不要显示撤回按钮」，
 * 免得给出一个点下去必然失败的入口。管理员能撤回更早的消息，这里不处理。
 */
const RECALL_WINDOW_MS = 2 * 60 * 1000;

export type MessageTone = "mine" | "other" | "system";

export interface ChatMessageRow {
  key: string;
  /** 发送者显示名：自己显示「我」，别人显示昵称；账号查不到时退回用户 ID。 */
  sender: string;
  /** `HH:mm`；不是今天则带 `MM-DD`。 */
  time: string;
  content: string;
  mine: boolean;
  recalled: boolean;
  /** 是否显示撤回按钮。 */
  canRecall: boolean;
  tone: MessageTone;
}

const ROLE_NAMES: Record<GroupDetail["role"], string> = {
  owner: "群主",
  admin: "管理员",
  member: "成员",
};

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function formatTime(iso: string, now: Date): string {
  const at = new Date(iso);
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const sameDay =
    at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
  return sameDay ? clock : `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${clock}`;
}

/**
 * 消息正文的显示文字。
 *
 * 图片与语音的 `content` 是**带时效的读取地址**（见 PROJECT_STATUS 4.18），
 * 直接贴出来会把一串签名 URL 甩到用户脸上；第一版不做图片渲染，所以按类型给占位文字。
 */
export function describeContent(message: GroupMessageView): string {
  if (message.recalledAt !== null) return message.content;
  switch (message.type) {
    case "text":
      return message.content;
    case "image":
      return "[图片]";
    case "voice":
      return message.voiceSeconds === undefined ? "[语音]" : `[语音 ${message.voiceSeconds} 秒]`;
    case "emoji":
      return message.content.trim() || "[表情]";
    case "room_invite":
      return "[房间邀请]";
    case "system":
      return message.content;
  }
}

/** 自己发的、没撤回过、且还在时间窗内 —— 三个条件都满足才显示撤回按钮。 */
export function canRecallMessage(message: GroupMessageView, meId: string, now: Date): boolean {
  if (message.senderId !== meId) return false;
  if (message.recalledAt !== null) return false;
  return now.getTime() - new Date(message.sentAt).getTime() < RECALL_WINDOW_MS;
}

export function buildMessageRows(
  messages: readonly GroupMessageView[],
  options: { meId: string; now: Date },
): ChatMessageRow[] {
  return messages.map((message) => {
    const mine = message.senderId === options.meId;
    const recalled = message.recalledAt !== null;
    return {
      key: message.messageId,
      sender: mine ? "我" : message.senderNickname ?? message.senderId,
      time: formatTime(message.sentAt, options.now),
      content: describeContent(message),
      mine,
      recalled,
      canRecall: canRecallMessage(message, options.meId, options.now),
      tone: recalled ? "system" : mine ? "mine" : "other",
    };
  });
}

/**
 * 消息行的估算高度。
 *
 * 不用 `Label.textHeight`：它在设置文本后要等一帧才准，而列表是同步重建的，
 * 用它会先按 0 排版再跳一下。按字数估算既稳定，又能脱离引擎单独测试。
 */
export function estimateMessageHeight(content: string, lineHeight = 36, headerHeight = 56, padding = 24): number {
  const charsPerLine = 20;
  const length = [...content].length;
  const lines = Math.max(1, Math.ceil(length / charsPerLine));
  return headerHeight + lines * lineHeight + padding;
}

/** 顶部那行群信息：群号、人数、我的角色。 */
export function describeGroupHeader(group: GroupDetail | null): string {
  if (!group) return "加载中…";
  return `群号 ${group.groupNo} · ${group.memberCount} 人 · ${ROLE_NAMES[group.role]}`;
}
