import "./lobby-style.js";
import type { ClientFlow, Screen } from "../flow.js";
import { button, element } from "./dom.js";
import { MediaCache } from "./media-cache.js";

type Home = Extract<Screen, { name: "home" }>;
type Chat = Extract<Screen, { name: "chat" }>;
const draft = new Map<string, string>();
const media = new MediaCache({ load: async (url) => { const r = await fetch(url); if (!r.ok) throw new Error("图片加载失败"); return r.blob(); } });
let updateMedia: (() => void) | undefined;
media.onChange(() => updateMedia?.());
export function avatar(name: string, url?: string): HTMLElement {
  const node = element("span", { className: "social-avatar", text: name.slice(0, 1) || "麻" });
  if (url) { const img = element("img"); img.src = url; img.alt = name; img.addEventListener("error", () => img.remove(), { once: true }); node.append(img); }
  return node;
}
function field(placeholder: string, type = "text"): HTMLInputElement {
  const input = element("input", { className: "text" }); input.placeholder = placeholder; input.type = type; return input;
}
function modal(title: string): { body: HTMLElement; close: () => void } {
  const dialog = element("dialog", { className: "social-dialog" });
  dialog.append(element("div", { className: "social-heading" }, element("h2", { text: title }), button("关闭", () => dialog.close())));
  const body = element("div", { className: "dialog-body" }); dialog.append(body); document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove(), { once: true }); dialog.showModal();
  return { body, close: () => dialog.close() };
}
export function passwordDialog(flow: ClientFlow): void {
  const { body } = modal("设置账号密码");
  const pass = field("密码（至少 8 位）", "password"); pass.autocomplete = "new-password";
  const again = field("再次输入密码", "password"); const status = element("p", { className: "hint" });
  body.append(element("p", { text: `登录账号：${flow.currentUserId ?? ""}` }), pass, again, button("保存密码", () => {
    if (pass.value.length < 8 || pass.value !== again.value) { status.textContent = "请填写至少 8 位且两次一致的密码"; return; }
    void flow.savePassword(pass.value).then((message) => { status.textContent = message; pass.value = ""; again.value = ""; });
  }, "primary"), status);
}
export function groupDialog(flow: ClientFlow, mode: "create" | "search"): void {
  const dialog = modal(mode === "create" ? "创建群聊" : "搜索群聊");
  const input = field(mode === "create" ? "填写群名称" : "输入群名称或 8 位群号"); input.maxLength = 30;
  const results = element("div", { className: "group-results" }); let searching = false;
  const submit = async () => {
    if (!input.value.trim() || searching) return; searching = true;
    try {
      if (mode === "create") { const error = await flow.createGroup(input.value); if (error) results.textContent = error; else dialog.close(); }
      else {
        const found = await flow.searchGroups(input.value);
        results.replaceChildren();
        if (!found.ok) { results.textContent = "搜索失败，请重试"; return; }
        if (!found.value.groups.length) results.textContent = "没有找到群聊";
        for (const group of found.value.groups) results.append(element("div", { className: "group-result" }, avatar(group.name), element("div", {}, element("strong", { text: group.name }), element("p", { className: "hint", text: `${group.groupNo} · ${group.memberCount} 人` })), button("加入群聊", () => {
          void flow.joinGroup(group.groupNo).then((error) => { if (error) results.textContent = error; else dialog.close(); });
        }, "primary")));
      }
    } finally { searching = false; }
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") void submit(); });
  dialog.body.append(input, button(mode === "create" ? "创建" : "搜索", () => void submit(), "primary"), results);
}
export function shareDialog(flow: ClientFlow): void {
  const dialog = modal("分享房间名片到群聊"); dialog.body.textContent = "正在加载群聊…";
  void flow.listShareGroups().then((result) => {
    dialog.body.replaceChildren();
    if (!result.ok) { dialog.body.textContent = "加载失败，请稍后再试"; return; }
    if (!result.value.groups.length) dialog.body.textContent = "还没有群聊，请返回大厅创建或加入群聊";
    const status = element("p", { className: "hint" });
    for (const group of result.value.groups) dialog.body.append(button(group.name, () => {
      void flow.shareRoom(group.groupId).then((error) => { status.textContent = error ?? "邀请名片已发送"; });
    }));
    dialog.body.append(status);
  });
}
export function lobby(screen: Home, flow: ClientFlow): HTMLElement {
  updateMedia = undefined;
  const root = element("section", { className: "lobby" });
  const header = element("div", { className: "social-heading" }, element("div", {}, element("h1", { text: "大厅" }), element("p", { className: "hint", text: "和牌友聊一聊，约一桌好牌" })), button("创建群聊", () => groupDialog(flow, "create"), "primary"));
  const search = button("⌕  搜索群聊 · 群名称 / 群号", () => groupDialog(flow, "search"), "group-search");
  const rooms = element("div", { className: "lobby-room-actions" });
  const number = field("6 位房间号"); number.maxLength = 6; number.inputMode = "numeric";
  rooms.append(button("＋ 创建房间", () => void flow.createRoom(), "primary"), number, button("加入房间", () => void flow.joinRoom(number.value)));
  if (screen.activeRoom) rooms.append(button(`返回房间 ${screen.activeRoom.roomNo}`, () => void flow.rejoinActiveRoom(), "primary"));
  const list = element("div", { className: "conversation-list" });
  if (!screen.groups.length) list.append(element("div", { className: "social-empty", text: "还没有群聊。创建一个群，或搜索群号加入牌友。" }));
  for (const group of screen.groups) {
    const row = button("", () => void flow.openChat(group.groupId), "conversation");
    row.append(avatar(group.name), element("div", { className: "conversation-copy" }, element("strong", { text: group.name }), element("p", { text: group.notice || `${group.memberCount} 位牌友 · 群号 ${group.groupNo}` })), element("span", { className: "hint", text: group.role === "owner" ? "群主" : group.role === "admin" ? "管理员" : "" }));
    list.append(row);
  }
  root.append(header, search, rooms, element("h2", { className: "list-heading", text: "群聊" }), list,
    element("div", { className: "social-footer" }, element("span", { text: `我的账号 ${screen.me.userId}` }), button("设置登录密码", () => passwordDialog(flow))));
  if (screen.error) root.append(element("p", { className: "error", text: screen.error }));
  return root;
}
function settings(screen: Chat, flow: ClientFlow): void {
  const group = screen.group; if (!group) return;
  const dialog = modal(`${group.name} · 群设置`); const status = element("p", { className: "hint" });
  const run = async (action: string, body: object) => {
    const error = await flow.manageGroup(action, body); status.textContent = error ?? "已保存";
    if (!error) { dialog.close(); if (flow.current.name === "chat") settings(flow.current, flow); }
  };
  dialog.body.append(element("p", { text: `群号 ${group.groupNo} · ${group.memberCount} 人` }));
  if (group.role !== "member") {
    const notice = field("群公告"); notice.value = group.notice; notice.maxLength = 500;
    dialog.body.append(notice, button("保存公告", () => void run("notice", { notice: notice.value })), button(group.allMuted ? "解除全员禁言" : "全员禁言", () => void run("all-mute", { enabled: !group.allMuted })));
  }
  for (const member of group.members) {
    const row = element("div", { className: "member-row" }, avatar(member.nickname ?? member.userId, member.avatarUrl), element("div", {}, element("strong", { text: member.nickname ?? member.userId }), element("p", { className: "hint", text: `${member.userId} · ${member.role === "owner" ? "群主" : member.role === "admin" ? "管理员" : "成员"}` })));
    if (member.userId !== screen.meId && member.role !== "owner") {
      if (group.role === "owner") row.append(button(member.role === "admin" ? "取消管理员" : "设为管理员", () => void run(`members/${member.userId}/admin`, { enabled: member.role !== "admin" })), button("转让群主", () => { if (window.confirm(`将群主转让给 ${member.nickname ?? member.userId}？`)) void run("transfer", { userId: member.userId }); }));
      if (group.role === "owner" || (group.role === "admin" && member.role === "member")) row.append(button("禁言 10 分钟", () => void run("mute", { userId: member.userId, minutes: 10 })), button("移出群聊", () => { if (window.confirm("确定移出该成员？")) void run(`members/${member.userId}/remove`, {}); }));
    }
    dialog.body.append(row);
  }
  dialog.body.append(status);
}
let mountedChat: { id: string; root: HTMLElement; messages: HTMLElement; header: HTMLElement; status: HTMLElement; input: HTMLInputElement; send: HTMLButtonElement } | undefined;
export function chat(screen: Chat, flow: ClientFlow): HTMLElement {
  if (mountedChat?.id !== screen.groupId) {
    const root = element("section", { className: "chat-shell" }); const header = element("header", { className: "chat-header" });
    const messages = element("div", { className: "chat-messages" }); const status = element("p", { className: "chat-status" });
    const input = field("发送消息"); input.value = draft.get(screen.groupId) ?? ""; input.maxLength = 2000;
    input.addEventListener("input", () => draft.set(screen.groupId, input.value));
    const send = button("发送", () => { const text = input.value; if (!text.trim()) return; input.value = ""; draft.delete(screen.groupId); void flow.sendText(text); }, "primary");
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) send.click(); });
    const imageInput = element("input"); imageInput.type = "file"; imageInput.accept = "image/*"; imageInput.hidden = true;
    imageInput.addEventListener("change", () => { const file = imageInput.files?.[0]; if (!file) return; imageInput.value = ""; void file.arrayBuffer().then((buffer) => flow.sendImage({ bytes: new Uint8Array(buffer), contentType: file.type })); });
    root.append(header, messages, status, element("div", { className: "chat-composer" }, button("＋ 图片", () => imageInput.click()), input, send, imageInput));
    mountedChat = { id: screen.groupId, root, messages, header, status, input, send };
  }
  const view = mountedChat;
  // 群成员表是异步拉回来的，在那之前 `screen.group` 还是 null。
  // 那时候 `settings()` 会直接 return —— 按钮点了没反应、也没有任何提示，
  // 看着像「群设置坏了」。所以加载完成前干脆把它置灰。
  const manage = button("群设置", () => settings(screen, flow));
  manage.disabled = !screen.group;
  view.header.replaceChildren(button("‹ 大厅", () => void flow.backHome()), element("div", {}, element("strong", { text: `${screen.group?.name ?? "群聊"}（${screen.group?.memberCount ?? "…"}）` }), element("p", { className: "hint", text: screen.group?.notice || "文字 · 图片 · 房间邀请" })), manage);
  view.status.textContent = screen.error ?? screen.notice ?? (screen.uploading ? "图片上传中…" : "");
  view.send.disabled = screen.sending || screen.uploading;
  const paint = () => {
    const atBottom = view.messages.scrollHeight - view.messages.scrollTop - view.messages.clientHeight < 100;
    const oldTop = view.messages.scrollTop;
    view.messages.replaceChildren();
    if (screen.hasEarlier) view.messages.append(button("查看更早消息", () => void flow.loadEarlier()));
    if (!screen.messages.length) view.messages.append(element("p", { className: "social-empty", text: "还没有消息，和牌友打个招呼吧" }));
    for (const message of screen.messages) {
      if (message.recalledAt || message.type === "system") { view.messages.append(element("p", { className: "system-message", text: message.content })); continue; }
      const mine = message.senderId === screen.meId;
      const bubble = element("div", { className: "chat-bubble" });
      if (message.type === "image") {
        const imageState = media.peek(message.messageId) ?? media.resolve(message.messageId, message.content);
        if (imageState.status === "ready") { const img = element("img", { className: "chat-image" }); img.src = imageState.url; img.alt = "群聊图片"; img.addEventListener("click", () => window.open(imageState.url, "_blank")); bubble.append(img); }
        else bubble.append(button(imageState.status === "loading" ? "图片加载中…" : "重试图片", () => { media.resolve(message.messageId, message.content, { retry: true }); }));
      } else if (message.type === "room_invite") {
        let number = ""; try { const value = JSON.parse(message.content); if (/^\d{6}$/.test(value.roomNo)) number = value.roomNo; } catch { /* 旧格式名片显示已失效 */ }
        const card = button("", () => { if (number) void flow.joinRoom(number); }, "room-invite-card"); card.disabled = !number;
        card.append(element("span", { className: "invite-icon", text: "麻" }), element("strong", { text: "一起来打绵阳麻将" }), element("p", { text: number ? `房间号 ${number}` : "邀请已失效" }), element("small", { text: "房间邀请 · 点击加入" })); bubble.append(card);
      } else if (message.type === "voice") { const audio = element("audio"); audio.controls = true; audio.src = message.content; bubble.append(audio); }
      else bubble.textContent = message.content;
      const content = element("div", { className: "chat-message-content" }, element("small", { text: `${message.senderNickname ?? message.senderId} · ${new Date(message.sentAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` }), bubble);
      if (screen.group?.role !== "member" || (mine && Date.now() - Date.parse(message.sentAt) < 120000)) content.append(button("撤回", () => void flow.recallMessage(message.messageId), "recall-message"));
      view.messages.append(element("div", { className: `chat-message${mine ? " mine" : ""}` }, avatar(message.senderNickname ?? message.senderId), content));
    }
    view.messages.scrollTop = atBottom ? view.messages.scrollHeight : oldTop;
  };
  updateMedia = paint; paint(); return view.root;
}
