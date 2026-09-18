import type { ClientFlow, Screen } from "@mianyang-mahjong/client";
import { TABLE_HEIGHT, TABLE_WIDTH, THEME, box, field, label, textButton } from "./widgets.js";
import { NON_TABLE, background, paperPanel } from "./non-table-skin.js";

/** 资料页：密钥有效但还没建号时，填昵称与头像建号。 */
export class ProfilePage {
  readonly view: Laya.Box;
  private readonly nicknameInput: Laya.TextInput;
  private readonly avatarInput: Laya.TextInput;
  private readonly errorLabel: Laya.Label;
  private readonly busyLabel: Laya.Label;
  private busy = false;
  private key = "";

  constructor(
    private readonly flow: ClientFlow,
    parent: Laya.Stage,
  ) {
    this.view = new Laya.Box();
    this.view.size(TABLE_WIDTH, TABLE_HEIGHT);
    parent.addChild(this.view);
    background(this.view, "login");
    box(this.view, 0, 0, TABLE_WIDTH, TABLE_HEIGHT, "#10251F66").mouseEnabled = false;
    const panel = paperPanel(this.view, 600, 130, 720, 820);

    label(panel, "完善资料", 46, { width: 720, align: "center", bold: true, color: NON_TABLE.ink }).pos(0, 55);
    label(panel, "首次使用，给自己起个名字", 24, { width: 720, align: "center", color: NON_TABLE.dim }).pos(0, 125);

    label(panel, "昵称（24 字以内）", 24, { color: NON_TABLE.dim }).pos(70, 220);
    this.nicknameInput = field(panel, 70, 260, 580, 82, "请输入昵称", 24).input;

    label(panel, "头像地址（可留空）", 24, { color: NON_TABLE.dim }).pos(70, 390);
    this.avatarInput = field(panel, 70, 430, 580, 82, "https://…").input;

    textButton(panel, "创建账号", 170, 570, 380, 82, NON_TABLE.jade, () => void this.submit(), 18);

    this.errorLabel = label(panel, "", 24, { width: 620, align: "center", color: THEME.bad, wordWrap: true });
    this.errorLabel.pos(50, 700);
    this.busyLabel = label(panel, "提交中…", 24, { width: 620, align: "center", color: NON_TABLE.dim });
    this.busyLabel.pos(50, 700);
    this.busyLabel.visible = false;
  }

  show(screen: Screen): void {
    if (screen.name !== "profile") return;
    // 密钥由页面流带来，提交时要带上。
    this.key = screen.key;
    this.busy = screen.busy;
    this.busyLabel.visible = screen.busy;
    this.errorLabel.visible = !screen.busy && screen.error !== undefined;
    this.errorLabel.text = screen.error ?? "";
  }

  private async submit(): Promise<void> {
    if (this.busy || this.key.length === 0) return;
    const nickname = this.nicknameInput.text.trim();
    if (nickname.length === 0) return;
    await this.flow.submitProfile(this.key, nickname, this.avatarInput.text.trim());
  }
}
