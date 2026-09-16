import type { ClientFlow, Screen } from "@mianyang-mahjong/client";
import { buildMessageRows, describeGroupHeader, estimateMessageHeight, type ChatMessageRow } from "./chat-model.js";
import { pickImage } from "./file-picker.js";
import { THEME, box, field, label, refill, setButtonText, textButton } from "./widgets.js";

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
  private readonly messagePanel: Laya.Panel;
  private readonly messageList: Laya.VBox;
  private readonly emptyLabel: Laya.Label;
  private readonly statusLabel: Laya.Label;
  private readonly input: Laya.TextInput;
  private sending = false;
  private uploading = false;

  constructor(
    private readonly flow: ClientFlow,
    parent: Laya.Stage,
  ) {
    this.view = new Laya.Box();
    this.view.size(750, 1334);
    parent.addChild(this.view);

    const header = box(this.view, 0, 0, 750, 110, THEME.panelBg);
    textButton(header, "返回", 24, 25, 130, 60, THEME.panelBg2, () => void this.flow.backHome());
    this.titleLabel = label(header, "", 30, { width: 420, align: "center", bold: true });
    this.titleLabel.pos(165, 42);
    textButton(header, "刷新", 596, 25, 130, 60, THEME.panelBg2, () => void this.flow.refreshChat());

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

    this.input = field(this.view, 30, 1190, 440, 80, "说点什么…", 500).input;
    this.imageButton = textButton(this.view, "图片", 480, 1190, 110, 80, THEME.panelBg2, () => void this.pickAndSendImage());
    this.sendButton = textButton(this.view, "发送", 598, 1190, 122, 80, THEME.accentDark, () => void this.send());
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

    const status = screen.error ?? screen.notice ?? (screen.uploading ? "图片上传中…" : "");
    this.statusLabel.text = status;
    this.statusLabel.color = screen.error ? THEME.bad : THEME.warn;
    this.statusLabel.visible = status.length > 0;

    this.renderMessages(buildMessageRows(screen.messages, { meId: screen.meId, now: new Date() }));
  }

  /** 离开页面时清掉没发出去的草稿，回来是干净的。 */
  hide(): void {
    this.input.text = "";
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

  private renderMessages(rows: ChatMessageRow[]): void {
    this.emptyLabel.visible = rows.length === 0;
    let total = 0;
    refill(this.messageList, rows.length, (index, row) => {
      const item = rows[index]!;
      const height = estimateMessageHeight(item.content);
      total += height + 10;
      row.size(ROW_WIDTH, height);
      row.bgColor = item.tone === "mine" ? THEME.panelBg2 : item.tone === "system" ? THEME.fieldBg : THEME.panelBg;

      const who = label(row, `${item.sender}  ${item.time}`, 22, { width: 540, color: THEME.textDim });
      who.pos(20, 14);
      const body = label(row, item.content, 28, {
        width: 540,
        wordWrap: true,
        color: item.tone === "system" ? THEME.textDim : THEME.text,
      });
      body.pos(20, 50);
      body.height = Math.max(36, height - 66);

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
