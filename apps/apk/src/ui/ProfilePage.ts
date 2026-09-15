import type { ClientFlow, Screen } from "@mianyang-mahjong/client";
import { DESIGN_HEIGHT, DESIGN_WIDTH, THEME, field, label, textButton } from "./widgets.js";

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
    this.view.size(DESIGN_WIDTH, DESIGN_HEIGHT);
    parent.addChild(this.view);

    label(this.view, "完善资料", 44, { width: 750, align: "center", bold: true, color: THEME.accent }).pos(0, 220);
    label(this.view, "首次使用，给自己起个名字", 26, { width: 750, align: "center", color: THEME.textDim }).pos(0, 300);

    label(this.view, "昵称（24 字以内）", 24, { color: THEME.textDim }).pos(75, 400);
    this.nicknameInput = field(this.view, 75, 440, 600, 88, "请输入昵称", 24).input;

    label(this.view, "头像地址（可留空）", 24, { color: THEME.textDim }).pos(75, 570);
    this.avatarInput = field(this.view, 75, 610, 600, 88, "https://…").input;

    textButton(this.view, "创建账号", 225, 760, 300, 88, THEME.accentDark, () => void this.submit());

    this.errorLabel = label(this.view, "", 26, { width: 750, align: "center", color: THEME.bad, wordWrap: true });
    this.errorLabel.pos(0, 890);
    this.busyLabel = label(this.view, "提交中…", 26, { width: 750, align: "center", color: THEME.textDim });
    this.busyLabel.pos(0, 890);
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
