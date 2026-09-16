import { describe, expect, it } from "vitest";
import type { GroupMessageView } from "@mianyang-mahjong/client";
import {
  buildMessageRows,
  canRecallMessage,
  describeContent,
  describeGroupHeader,
  estimateMessageHeight,
} from "../src/ui/chat-model.js";

const ME = "1234567890";

/** 用本地时间造 `sentAt`，再转成 ISO —— 断言里的 `HH:mm` 才不会随测试机器时区变。 */
const at = (localTime: string): string => new Date(localTime).toISOString();

function message(overrides: Partial<GroupMessageView> = {}): GroupMessageView {
  return {
    messageId: "m-1",
    senderId: ME,
    senderNickname: "张三",
    sentAt: at("2026-09-16 10:00:00"),
    type: "text",
    content: "你好",
    recalledAt: null,
    ...overrides,
  };
}

const NOW = new Date("2026-09-16 12:00:00");

describe("chat model", () => {
  it("marks my own messages and shows the sender's nickname for others", () => {
    const rows = buildMessageRows(
      [
        message({ messageId: "a", senderId: ME, senderNickname: "张三" }),
        message({ messageId: "b", senderId: "9999999999", senderNickname: "李四" }),
      ],
      { meId: ME, now: NOW },
    );

    expect(rows[0]).toMatchObject({ sender: "我", mine: true, tone: "mine" });
    expect(rows[1]).toMatchObject({ sender: "李四", mine: false, tone: "other" });
  });

  it("falls back to the user id when the nickname is missing", () => {
    const rows = buildMessageRows([message({ senderId: "9999999999", senderNickname: undefined })], {
      meId: ME,
      now: NOW,
    });

    expect(rows[0]!.sender).toBe("9999999999");
  });

  it("shows a clock for today and a date for older messages", () => {
    const rows = buildMessageRows(
      [
        message({ messageId: "today", sentAt: at("2026-09-16 09:05:00") }),
        message({ messageId: "older", sentAt: at("2026-09-14 21:30:00") }),
      ],
      { meId: ME, now: NOW },
    );

    expect(rows[0]!.time).toBe("09:05");
    expect(rows[1]!.time).toBe("09-14 21:30");
  });

  it("turns a recalled message into a system row with the server's text", () => {
    const rows = buildMessageRows([message({ content: "[消息已撤回]", recalledAt: at("2026-09-16 10:01:00") })], {
      meId: ME,
      now: NOW,
    });

    expect(rows[0]).toMatchObject({ tone: "system", recalled: true, content: "[消息已撤回]", canRecall: false });
  });

  it("only offers recall on my own recent messages", () => {
    const mine = message({ sentAt: at("2026-09-16 11:59:00") });
    const tooOld = message({ sentAt: at("2026-09-16 11:50:00") });
    const theirs = message({ senderId: "9999999999", sentAt: at("2026-09-16 11:59:00") });
    const recalled = message({ sentAt: at("2026-09-16 11:59:00"), recalledAt: at("2026-09-16 11:59:30") });

    expect(canRecallMessage(mine, ME, NOW)).toBe(true);
    expect(canRecallMessage(tooOld, ME, NOW)).toBe(false);
    expect(canRecallMessage(theirs, ME, NOW)).toBe(false);
    expect(canRecallMessage(recalled, ME, NOW)).toBe(false);
  });

  it("describes non-text messages instead of leaking the signed url", () => {
    const signed = "https://bucket.example.com/uploads/1/image/a?sign=abc";
    expect(describeContent(message({ type: "image", content: signed }))).toBe("[图片]");
    expect(describeContent(message({ type: "voice", content: signed, voiceSeconds: 7 }))).toBe("[语音 7 秒]");
    expect(describeContent(message({ type: "voice", content: signed }))).toBe("[语音]");
    expect(describeContent(message({ type: "room_invite", content: "room-1" }))).toBe("[房间邀请]");
    expect(describeContent(message({ type: "text", content: "在的" }))).toBe("在的");
  });

  it("grows the row height with longer content", () => {
    const short = estimateMessageHeight("你好");
    const long = estimateMessageHeight("一一二三".repeat(40));

    expect(long).toBeGreaterThan(short);
    expect(short).toBeGreaterThan(0);
  });

  it("describes the group header, and says so while it is still loading", () => {
    expect(describeGroupHeader(null)).toBe("加载中…");
    expect(
      describeGroupHeader({
        groupId: "g1",
        groupNo: "12345678",
        name: "牌友群",
        ownerId: ME,
        notice: "",
        allMuted: false,
        memberCount: 4,
        role: "owner",
        members: [],
      }),
    ).toBe("群号 12345678 · 4 人 · 群主");
  });
});
