import { settingsDialog, SOCIAL, socialAvatar } from "./SocialDialogs.js";
import type { ClientFlow, Screen, VoiceRecorder, GroupMessageView } from "@mianyang-mahjong/client";
import { BrowserVoiceRecorder, MAX_VOICE_SECONDS } from "@mianyang-mahjong/client";
import { buildMessageRows, describeGroupHeader, estimateMessageHeight, type ChatMessageRow } from "./chat-model.js";
import { pickImage } from "./file-picker.js";
import { THEME as BASE_THEME, box, field, label, refill, setButtonText, textButton } from "./widgets.js";
import { NON_TABLE, background, paperPanel } from "./non-table-skin.js";

const THEME = { ...BASE_THEME, panelBg: "#f7f7f7", panelBg2: "#d7e5dc", text: SOCIAL.ink, textDim: SOCIAL.dim, accentDark: SOCIAL.green };

/** 消息行宽度；右侧要留出撤回按钮的位置。 */
const ROW_WIDTH = 1020;

/**
 * 群聊页面：群信息、消息列表、发消息、发图片与撤回。
 *
 * 和其他页面一样不持有业务状态：一切都来自 `chat` 这个 `Screen`，
 * 本页只保留「发送中 / 上传中」这类纯展示性的本地标记。
 */
export class ChatPage {
  readonly view: Laya.Box;
  private readonly titleLabel: Laya.Label;
  private readonly metaLabel: Laya.Label;
  private readonly noticeLabel: Laya.Label;
  private readonly earlierButton: Laya.Box;
  private readonly sendButton: Laya.Box;
  private readonly imageButton: Laya.Box;
  private readonly voiceButton: Laya.Box;
  private readonly messagePanel: Laya.Panel;
  private readonly messageList: Laya.VBox;
  private readonly emptyLabel: Laya.Label;
  private readonly statusLabel: Laya.Label;
  private readonly input: Laya.TextInput;
  private readonly memberList: Laya.VBox;
  private messages: GroupMessageView[] = [];
  private sending = false;
  private uploading = false;
  /** 录音是页面的本地状态（`Screen` 里没有它）：它是纯界面过程，不影响业务数据。 */
  private recorder: VoiceRecorder | undefined;
  private recording = false;
  private recordTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly flow: ClientFlow,
    parent: Laya.Stage,
  ) {
    this.view = new Laya.Box();
    this.view.size(1920, 1080);
    parent.addChild(this.view);
    background(this.view, "group");
    box(this.view, 0, 0, 1920, 1080, "#F4EEDC55").mouseEnabled = false;

    const left = paperPanel(this.view, 28, 28, 310, 1024);
    textButton(left, "返回大厅", 22, 22, 266, 64, "#789084", () => void this.flow.backHome(), 16);
    label(left, "牌友群", 30, { width: 266, align: "center", color: NON_TABLE.ink, bold: true }).pos(22, 125);
    const currentGroup = box(left, 18, 190, 274, 110, "#DDEAE2");
    this.titleLabel = label(currentGroup, "", 27, { width: 240, align: "center", bold: true, color: NON_TABLE.ink });
    this.titleLabel.pos(17, 18);
    this.metaLabel = label(currentGroup, "", 18, { width: 240, align: "center", color: NON_TABLE.dim });
    this.metaLabel.pos(17, 63);
    label(left, "当前群聊", 20, { width: 266, align: "center", color: NON_TABLE.dim }).pos(22, 330);

    const center = paperPanel(this.view, 360, 28, 1130, 1024);
    const header = box(center, 0, 0, 1130, 105, "#F4EEDCEE");
    label(header, "群聊", 34, { width: 780, align: "center", bold: true, color: NON_TABLE.ink }).pos(175, 24);
    textButton(header, "群设置", 930, 20, 165, 62, SOCIAL.green, () => { if (this.flow.current.name === "chat") settingsDialog(this.view, this.flow, this.flow.current); }, 16);

    this.noticeLabel = label(center, "", 20, { width: 1020, color: THEME.warn, wordWrap: true });
    this.noticeLabel.pos(55, 108);

    this.earlierButton = textButton(center, "加载更早的消息", 435, 145, 260, 52, THEME.panelBg2, () => void this.flow.loadEarlier(), 14);

    // 消息列表：Panel 裁剪 + 内部一列 VBox，由 renderMessages 重建。
    const panel = new Laya.Panel();
    panel.pos(55, 210);
    panel.size(1020, 660);
    panel.vScrollBarSkin = "";
    panel.hScrollBarSkin = "";
    this.messageList = new Laya.VBox();
    this.messageList.pos(0, 0);
    this.messageList.width = 1020;
    this.messageList.space = 10;
    panel.addChild(this.messageList);
    center.addChild(panel);
    this.messagePanel = panel;

    this.emptyLabel = label(center, "还没有消息，打个招呼吧", 24, { width: 1020, align: "center", color: THEME.textDim });
    this.emptyLabel.pos(55, 510);

    this.statusLabel = label(center, "", 20, { width: 1020, align: "center", color: THEME.warn, wordWrap: true });
    this.statusLabel.pos(55, 875);

    this.input = field(center, 55, 920, 650, 72, "说点什么…", 500).input;
    this.voiceButton = textButton(center, "语音", 720, 920, 100, 72, THEME.panelBg2, () => void this.toggleRecording(), 14);
    this.imageButton = textButton(center, "图片", 835, 920, 100, 72, THEME.panelBg2, () => void this.pickAndSendImage(), 14);
    this.sendButton = textButton(center, "发送", 950, 920, 125, 72, THEME.accentDark, () => void this.send(), 14);

    const right = paperPanel(this.view, 1512, 28, 380, 1024);
    label(right, "群成员", 30, { width: 330, align: "center", color: NON_TABLE.ink, bold: true }).pos(25, 28);
    const members = new Laya.Panel(); members.pos(25, 95); members.size(330, 880); members.vScrollBarSkin = "";
    this.memberList = new Laya.VBox(); this.memberList.width = 330; this.memberList.space = 8; members.addChild(this.memberList); right.addChild(members);
  }

  show(screen: Screen): void {
    if (screen.name !== "chat") return;

    this.titleLabel.text = screen.group?.name ?? "群聊";
    this.metaLabel.text = describeGroupHeader(screen.group);
    const notice = screen.group?.notice ?? "";
    this.noticeLabel.text = notice.length > 0 ? `公告：${notice}` : "";
    this.noticeLabel.visible = notice.length > 0;

    this.earlierButton.visible = screen.hasEarlier || screen.loadingEarlier;
    setButtonText(this.earlierButton, screen.loadingEarlier ? "加载中…" : "加载更早的消息");

    this.sending = screen.sending;
    this.uploading = screen.uploading;
    setButtonText(this.sendButton, screen.uploading ? "上传中…" : screen.sending ? "发送中…" : "发送");
    setButtonText(this.imageButton, screen.uploading ? "上传中…" : "图片");
    // 录音中的文案由页面自己维护（那是本地状态），所以正在录音时不去覆盖它。
    if (!this.recording) setButtonText(this.voiceButton, screen.uploading ? "上传中…" : "语音");

    const status = screen.error ?? screen.notice ?? (screen.uploading ? "图片上传中…" : "");
    this.statusLabel.text = status;
    this.statusLabel.color = screen.error ? THEME.bad : THEME.warn;
    this.statusLabel.visible = status.length > 0;

    this.messages = screen.messages;
    this.renderMessages(buildMessageRows(screen.messages, { meId: screen.meId, now: new Date() }));
    refill(this.memberList, screen.group?.members.length ?? 0, (index, row) => {
      const member = screen.group!.members[index]!; row.size(330, 76); row.bgColor = index % 2 ? "#E9E2D1" : "#F2EBD9";
      socialAvatar(row, member.nickname ?? member.userId, member.avatarUrl, 8, 8, 58);
      label(row, member.nickname ?? member.userId, 21, { width: 220, color: NON_TABLE.ink }).pos(78, 10);
      label(row, member.role === "owner" ? "群主" : member.role === "admin" ? "管理员" : "成员", 17, { color: NON_TABLE.dim }).pos(78, 43);
    });
  }

  /** 离开页面时清掉没发出去的草稿，并放弃正在进行的录音（不上传也不留）。 */
  hide(): void {
    this.input.text = "";
    this.stopRecordTimer();
    if (this.recording) {
      this.recorder?.cancel();
      this.recorder = undefined;
      this.recording = false;
      setButtonText(this.voiceButton, "语音");
    }
  }

  private async send(): Promise<void> {
    const text = this.input.text.trim();
    if (this.sending || this.uploading || text.length === 0) return;
    // 先清空输入框；失败会显示在状态行上，不让用户对着一个「以为没发出去」的框反复点。
    this.input.text = "";
    await this.flow.sendText(text);
  }

  /** 选一张图发出去。取消选择或环境不支持时什么都不做。 */
  private async pickAndSendImage(): Promise<void> {
    if (this.sending || this.uploading) return;
    const picked = await pickImage();
    if (!picked) return;
    await this.flow.sendImage({ bytes: picked.bytes, contentType: picked.contentType });
  }

  /** 点一下开始录音，再点一下停止并发送。 */
  private async toggleRecording(): Promise<void> {
    if (this.sending || this.uploading) return;
    if (this.recording) {
      await this.finishRecording();
      return;
    }
    const recorder = this.recorder ?? new BrowserVoiceRecorder();
    try {
      await recorder.start();
    } catch {
      // 两种情况都落在这里：原生运行时没有录音能力；浏览器里没给麦克风权限。
      this.recorder = undefined;
      this.showStatus("录不了音：需要允许麦克风权限，且页面要在 HTTPS 或 localhost 下", true);
      return;
    }
    this.recorder = recorder;
    this.recording = true;
    this.recordTimer = setInterval(() => this.tickRecording(), 500);
    this.tickRecording();
  }

  /** 停止录音并把这段语音发出去。 */
  private async finishRecording(): Promise<void> {
    if (!this.recording) return;
    this.stopRecordTimer();
    this.recording = false;
    const recorder = this.recorder;
    this.recorder = undefined;
    setButtonText(this.voiceButton, "语音");
    if (!recorder) return;
    const recorded = await recorder.stop();
    // 一秒钟都没录到就别发了（服务端只收 1 秒以上）。
    if (!recorded) return;
    await this.flow.sendVoice(recorded);
  }

  /** 刷新录音秒数；到上限自动停下发出去（服务端只收 1–60 秒）。 */
  private tickRecording(): void {
    const seconds = this.recorder?.elapsedSeconds() ?? 0;
    setButtonText(this.voiceButton, `录音 ${seconds}s`);
    if (seconds >= MAX_VOICE_SECONDS) void this.finishRecording();
  }

  private stopRecordTimer(): void {
    if (this.recordTimer !== null) clearInterval(this.recordTimer);
    this.recordTimer = null;
  }

  /** 页面自己发一条状态提示（录音相关的错误不走 `Screen`）。 */
  private showStatus(text: string, isError: boolean): void {
    this.statusLabel.text = text;
    this.statusLabel.color = isError ? THEME.bad : THEME.warn;
    this.statusLabel.visible = text.length > 0;
  }

  private renderMessages(rows: ChatMessageRow[]): void {
    this.emptyLabel.visible = rows.length === 0;
    let total = 0;
    refill(this.messageList, rows.length, (index, row) => {
      const item = rows[index]!;
      const message = this.messages[index]!;
      const isImage = !item.recalled && message.type === "image";
      const isInvite = !item.recalled && message.type === "room_invite";
      const height = isImage ? 320 : isInvite ? 245 : estimateMessageHeight(item.content);
      total += height + 10;
      row.size(ROW_WIDTH, height);
      const bubbleX = item.mine ? 235 : 78;
      socialAvatar(row, item.sender, undefined, item.mine ? 950 : 0, 0, 60);
      const bubble = box(row, bubbleX, 34, 700, height - 40, item.mine ? "#B7DDC8" : "#F4EEDC");
      label(row, `${item.sender}  ${item.time}`, 20, { width: 700, color: SOCIAL.dim }).pos(bubbleX, 4);
      if (isImage) {
        const image = new Laya.Image(); image.skin = message.content; image.pos(12, 12); image.size(260, 240); bubble.addChild(image);
        image.on(Laya.Event.CLICK, null, () => {
          const preview = box(this.view, 0, 0, 1920, 1080, "#202622EE"); preview.zOrder = 120;
          const full = new Laya.Image(); full.skin = message.content; full.pos(510, 90); full.size(900, 820); preview.addChild(full);
          textButton(preview, "关闭图片", 810, 940, 300, 70, SOCIAL.green, () => preview.destroy(true), 16);
        });
      } else if (isInvite) {
        let roomNo = "";
        try { const invite = JSON.parse(message.content); if (/^\d{6}$/.test(invite.roomNo)) roomNo = invite.roomNo; } catch { /* 历史无效名片 */ }
        bubble.bgColor = "#35594E";
        label(bubble, "绵阳麻将 · 房间邀请", 28, { color: "#F4EEDC" }).pos(18, 18);
        label(bubble, roomNo ? `房间号 ${roomNo}` : "邀请已失效", 26, { color: "#F4EEDC" }).pos(18, 65);
        if (roomNo) textButton(bubble, "加入房间", 470, 100, 200, 60, SOCIAL.green, () => { void this.flow.joinRoom(roomNo); }, 14);
      } else {
        const body = label(bubble, item.content, 28, { width: 665, wordWrap: true, color: item.tone === "system" ? SOCIAL.dim : SOCIAL.ink });
        body.pos(16, 12); body.height = height - 60;
      }

      if (item.canRecall) {
        textButton(row, "撤回", ROW_WIDTH - 132, 12, 112, 48, THEME.panelBg2, () => void this.flow.recallMessage(item.key));
      }
    });
    // VBox 的 height 不会跟着子节点自己涨，而 Panel 靠它算滚动范围，所以显式设一次。
    this.messageList.height = total;
    this.scrollToBottom();
  }

  /** 新消息进来后停在最新一条上。拿不到滚动条就放弃，不影响消息本身。 */
  private scrollToBottom(): void {
    const bar = (this.messagePanel as unknown as { vScrollBar?: { value: number } }).vScrollBar;
    if (bar) bar.value = Math.max(0, this.messageList.height - this.messagePanel.height);
  }
}
