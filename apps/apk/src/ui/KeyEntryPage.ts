import type { ClientFlow, Screen } from "@mianyang-mahjong/client";
import { DESIGN_HEIGHT, DESIGN_WIDTH, THEME, field, label, textButton } from "./widgets.js";

/** 密钥登录页：输入邀请密钥，已激活进主页，未激活由 flow 转到资料页。 */
export class KeyEntryPage {
  readonly view: Laya.Box;
  private readonly keyInput: Laya.TextInput;
  private readonly errorLabel: Laya.Label;
  private readonly busyLabel: Laya.Label;
  private busy = false;

  constructor(
    private readonly flow: ClientFlow,
    parent: Laya.Stage,
  ) {
    this.view = new Laya.Box();
    this.view.size(DESIGN_WIDTH, DESIGN_HEIGHT);
    parent.addChild(this.view);

    label(this.view, "绵阳血战麻将", 56, { width: 750, align: "center", bold: true, color: THEME.accent }).pos(0, 260);
    label(this.view, "输入邀请密钥开始游戏", 26, { width: 750, align: "center", color: THEME.textDim }).pos(0, 350);

    this.keyInput = field(this.view, 75, 470, 600, 88, "MYMJ-XXXX-XXXX-XXXX-XXXX", 32).input;
    this.keyInput.on(Laya.Event.ENTER, null, () => { void this.submit(); });

    textButton(this.view, "进 入", 225, 610, 300, 88, THEME.accentDark, () => void this.submit());

    this.errorLabel = label(this.view, "", 26, { width: 750, align: "center", color: THEME.bad, wordWrap: true });
    this.errorLabel.pos(0, 740);
    this.busyLabel = label(this.view, "登录中…", 26, { width: 750, align: "center", color: THEME.textDim });
    this.busyLabel.pos(0, 740);
    this.busyLabel.visible = false;
  }

  show(screen: Screen): void {
    if (screen.name !== "key-entry") return;
    this.busy = screen.busy;
    this.busyLabel.visible = screen.busy;
    this.errorLabel.visible = !screen.busy && screen.error !== undefined;
    this.errorLabel.text = screen.error ?? "";
  }

  private async submit(): Promise<void> {
    const key = this.keyInput.text.trim();
    if (this.busy || key.length === 0) return;
    await this.flow.enterKey(key);
  }
}
