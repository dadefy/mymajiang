import { settingsDialog, SOCIAL, socialAvatar } from "./SocialDialogs.js";
import type { ClientFlow, Screen, VoiceRecorder, GroupMessageView } from "@mianyang-mahjong/client";
import { BrowserVoiceRecorder, MAX_VOICE_SECONDS } from "@mianyang-mahjong/client";
import { buildMessageRows, describeGroupHeader, estimateMessageHeight, type ChatMessageRow } from "./chat-model.js";
import { pickImage } from "./file-picker.js";
import { THEME as BASE_THEME, box, field, label, refill, setButtonText, textButton } from "./widgets.js";

const THEME = { ...BASE_THEME, panelBg: "#f7f7f7", panelBg2: "#d7e5dc", text: SOCIAL.ink, textDim: SOCIAL.dim, accentDark: SOCIAL.green };

/** 消息行宽度；右侧要留出撤回按钮的位置。 */
const ROW_WIDTH = 690;

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
    this.view.size(750, 1334);
    this.view.bgColor = SOCIAL.bg;
    parent.addChild(this.view);

    const header = box(this.view, 0, 0, 750, 110, THEME.panelBg);
    textButton(header, "返回", 24, 25, 130, 60, THEME.panelBg2, () => void this.flow.backHome());
    this.titleLabel = label(header, "", 30, { width: 420, align: "center", bold: true });
    this.titleLabel.pos(165, 42);
    textButton(header, "群设置", 596, 25, 130, 60, SOCIAL.green, () => { if (this.flow.current.name === "chat") settingsDialog(this.view, this.flow, this.flow.current); });

    this.metaLabel = label(this.view, "", 22, { width: 690, color: THEME.textDim });
    this.metaLabel.pos(30, 124);
    this.noticeLabel = label(this.view, "", 22, { width: 690, color: THEME.warn, wordWrap: true });
    this.noticeLabel.pos(30, 156);

    this.earlierButton = textButton(this.view, "加载更早的消息", 245, 202, 260, 56, THEME.panelBg2, () => void this.flow.loadEarlier());

    // 消息列表：Panel 裁剪 + 内部一列 VBox，由 renderMessages 重建。
    const panel = new Laya.Panel();
    panel.pos(30, 272);
    panel.size(690, 850);
    panel.vScrollBarSkin = "";
    panel.hScrollBarSkin = "";
    this.messageList = new Laya.VBox();
    this.messageList.pos(0, 0);
    this.messageList.width = 690;
    this.messageList.space = 10;
    panel.addChild(this.messageList);
    this.view.addChild(panel);
    this.messagePanel = panel;

    this.emptyLabel = label(this.view, "还没有消息，打个招呼吧", 24, { width: 690, align: "center", color: THEME.textDim });
    this.emptyLabel.pos(30, 660);

    this.statusLabel = label(this.view, "", 22, { width: 690, align: "center", color: THEME.warn, wordWrap: true });
    this.statusLabel.pos(30, 1136);

    this.input = field(this.view, 30, 1190, 360, 80, "说点什么…", 500).input;
    this.voiceButton = textButton(this.view, "语音", 398, 1190, 90, 80, THEME.panelBg2, () => void this.toggleRecording());
    this.imageButton = textButton(this.view, "图片", 496, 1190, 90, 80, THEME.panelBg2, () => void this.pickAndSendImage());
    this.sendButton = textButton(this.view, "发送", 594, 1190, 126, 80, THEME.accentDark, () => void this.send());
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
      const bubbleX = item.mine ? 100 : 78;
      socialAvatar(row, item.sender, undefined, item.mine ? 620 : 0, 0, 60);
      const bubble = box(row, bubbleX, 34, 500, height - 40, item.mine ? "#a5e877" : SOCIAL.panel);
      label(row, `${item.sender}  ${item.time}`, 20, { width: 500, color: SOCIAL.dim }).pos(bubbleX, 4);
      if (isImage) {
        const image = new Laya.Image(); image.skin = message.content; image.pos(12, 12); image.size(260, 240); bubble.addChild(image);
        image.on(Laya.Event.CLICK, null, () => {
          const preview = box(this.view, 0, 0, 750, 1334, "#202622"); preview.zOrder = 120;
          const full = new Laya.Image(); full.skin = message.content; full.pos(25, 190); full.size(700, 900); preview.addChild(full);
          textButton(preview, "关闭图片", 250, 1160, 250, 70, SOCIAL.green, () => preview.destroy(true));
        });
      } else if (isInvite) {
        let roomNo = "";
        try { const invite = JSON.parse(message.content); if (/^\d{6}$/.test(invite.roomNo)) roomNo = invite.roomNo; } catch { /* 历史无效名片 */ }
        label(bubble, "绵阳麻将 · 房间邀请", 28, { color: SOCIAL.ink }).pos(18, 18);
        label(bubble, roomNo ? `房间号 ${roomNo}` : "邀请已失效", 26, { color: SOCIAL.ink }).pos(18, 65);
        if (roomNo) textButton(bubble, "点击进入房间", 18, 112, 450, 60, SOCIAL.green, () => { void this.flow.joinRoom(roomNo); });
      } else {
        const body = label(bubble, item.content, 28, { width: 465, wordWrap: true, color: item.tone === "system" ? SOCIAL.dim : SOCIAL.ink });
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
