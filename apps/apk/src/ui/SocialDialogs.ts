import type { ClientFlow, Screen } from "@mianyang-mahjong/client";
import { box, field, label, scrollList, textButton } from "./widgets.js";
export const SOCIAL = { bg: "#ededed", panel: "#ffffff", ink: "#252b27", dim: "#818b84", green: "#07a653" };
function dialog(parent: Laya.Box, title: string) {
  const overlay = box(parent, 0, 0, 750, 1334, "#dce2de"); overlay.zOrder = 100;
  label(overlay, title, 30, { color: SOCIAL.ink, width: 500 }).pos(30, 36);
  const close = () => overlay.destroy(true);
  textButton(overlay, "关闭", 600, 24, 120, 60, SOCIAL.green, close);
  const status = label(overlay, "", 22, { width: 680, color: "#a34732", wordWrap: true }); status.pos(35, 1200);
  return { overlay, close, status };
}
export function socialAvatar(parent: Laya.Box, name: string, url: string | undefined, x: number, y: number, size = 72): void {
  const base = box(parent, x, y, size, size, "#d6e8dc");
  label(base, name.slice(0, 1) || "麻", size / 2, { width: size, align: "center", color: "#35734b" }).pos(0, size / 4);
  if (url && /^https?:/.test(url)) { const image = new Laya.Image(); image.skin = url; image.size(size, size); base.addChild(image); }
}
export function groupDialog(parent: Laya.Box, flow: ClientFlow, mode: "create" | "search"): void {
  const d = dialog(parent, mode === "create" ? "创建群聊" : "搜索群聊");
  const input = field(d.overlay, 30, 120, 500, 70, mode === "create" ? "群名称" : "群名称或 8 位群号", 30).input;
  const list = scrollList(d.overlay, 30, 235, 690, 920);
  textButton(d.overlay, mode === "create" ? "创建" : "搜索", 550, 120, 170, 70, SOCIAL.green, () => {
    void (async () => {
      if (!input.text.trim()) return;
      if (mode === "create") { const error = await flow.createGroup(input.text); if (error) d.status.text = error; else d.close(); return; }
      const result = await flow.searchGroups(input.text); list.removeChildren();
      if (!result.ok) { d.status.text = "搜索失败，请重试"; return; }
      d.status.text = result.value.groups.length ? "" : "未找到群聊";
      for (const group of result.value.groups) {
        const row = box(list, 0, 0, 690, 100, SOCIAL.panel);
        label(row, group.name, 28, { color: SOCIAL.ink, width: 430 }).pos(20, 12);
        label(row, `${group.groupNo} · ${group.memberCount} 人`, 22, { color: SOCIAL.dim }).pos(20, 55);
        textButton(row, "加入", 520, 18, 145, 60, SOCIAL.green, () => { void flow.joinGroup(group.groupNo).then((error) => { if (error) d.status.text = error; else d.close(); }); });
      }
      list.height = result.value.groups.length * 110;
    })();
  });
}
export function passwordDialog(parent: Laya.Box, flow: ClientFlow): void {
  const d = dialog(parent, "设置登录密码");
  label(d.overlay, `账号 ID：${flow.currentUserId}`, 28, { color: SOCIAL.ink }).pos(35, 150);
  const password = field(d.overlay, 35, 230, 680, 80, "密码（至少 8 位）", 200).input; password.type = "password";
  const repeat = field(d.overlay, 35, 340, 680, 80, "再次输入密码", 200).input; repeat.type = "password";
  textButton(d.overlay, "保存密码", 200, 470, 350, 80, SOCIAL.green, () => {
    if (password.text.length < 8 || password.text !== repeat.text) { d.status.text = "请填写至少 8 位且两次一致的密码"; return; }
    void flow.savePassword(password.text).then((message) => { password.text = ""; repeat.text = ""; d.status.text = message; });
  });
}
export function shareDialog(parent: Laya.Box, flow: ClientFlow): void {
  const d = dialog(parent, "分享房间名片到群聊"); const list = scrollList(d.overlay, 30, 130, 690, 1000);
  void flow.listShareGroups().then((result) => {
    if (!result.ok) { d.status.text = "群聊加载失败"; return; }
    if (!result.value.groups.length) d.status.text = "请先返回大厅创建或加入群聊";
    for (const group of result.value.groups) textButton(list, group.name, 0, 0, 690, 80, SOCIAL.green, () => {
      void flow.shareRoom(group.groupId).then((error) => { d.status.text = error ?? "邀请名片已发送"; });
    });
    list.height = result.value.groups.length * 90;
  });
}
export function settingsDialog(parent: Laya.Box, flow: ClientFlow, screen: Extract<Screen, { name: "chat" }>): void {
  const group = screen.group; if (!group) return;
  const d = dialog(parent, "群设置");
  const run = async (action: string, body: object) => {
    const error = await flow.manageGroup(action, body);
    if (error) d.status.text = error;
    else { d.close(); if (flow.current.name === "chat") settingsDialog(parent, flow, flow.current); }
  };
  label(d.overlay, `${group.name} · ${group.groupNo}`, 26, { color: SOCIAL.ink }).pos(30, 110);
  let top = 160;
  if (group.role !== "member") {
    const notice = field(d.overlay, 30, top, 490, 60, "群公告", 500).input; notice.text = group.notice;
    textButton(d.overlay, "保存公告", 540, top, 180, 60, SOCIAL.green, () => { void run("notice", { notice: notice.text }); }); top += 80;
    textButton(d.overlay, group.allMuted ? "解除全员禁言" : "全员禁言", 30, top, 270, 60, SOCIAL.green, () => { void run("all-mute", { enabled: !group.allMuted }); }); top += 80;
  }
  const list = scrollList(d.overlay, 30, top, 690, 1160 - top);
  for (const member of group.members) {
    const row = box(list, 0, 0, 690, 220, SOCIAL.panel);
    socialAvatar(row, member.nickname ?? member.userId, member.avatarUrl, 10, 10, 64);
    label(row, `${member.nickname ?? member.userId} · ${member.role === "owner" ? "群主" : member.role === "admin" ? "管理员" : "成员"}`, 25, { color: SOCIAL.ink, width: 580 }).pos(90, 15);
    label(row, member.userId, 22, { color: SOCIAL.dim }).pos(90, 50);
    if (member.userId !== screen.meId && member.role !== "owner") {
      if (group.role === "owner") {
        textButton(row, member.role === "admin" ? "取消管理员" : "设为管理员", 10, 90, 210, 50, SOCIAL.green, () => { void run(`members/${member.userId}/admin`, { enabled: member.role !== "admin" }); });
        let confirmed = false;
        textButton(row, "转让群主", 235, 90, 210, 50, SOCIAL.green, () => {
          if (!confirmed) { confirmed = true; d.status.text = `再次点击确认转让群主给 ${member.nickname ?? member.userId}`; return; }
          void run("transfer", { userId: member.userId });
        });
      }
      if (group.role === "owner" || (group.role === "admin" && member.role === "member")) {
        textButton(row, "禁言 10 分钟", 10, 155, 210, 50, SOCIAL.green, () => { void run("mute", { userId: member.userId, minutes: 10 }); });
        let confirmed = false;
        textButton(row, "移出群聊", 235, 155, 210, 50, "#b56252", () => { if (!confirmed) { confirmed = true; d.status.text = "再次点击确认移出该成员"; return; } void run(`members/${member.userId}/remove`, {}); });
      }
    }
  }
  list.height = group.members.length * 230;
}
