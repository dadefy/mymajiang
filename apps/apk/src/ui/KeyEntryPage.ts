import type { ClientFlow, Screen } from "@mianyang-mahjong/client";
import { TABLE_HEIGHT, TABLE_WIDTH, THEME, box, field, label, textButton } from "./widgets.js";
import { NON_TABLE, background, paperPanel } from "./non-table-skin.js";

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
    this.view.size(TABLE_WIDTH, TABLE_HEIGHT);
    parent.addChild(this.view);
    background(this.view, "login");
    box(this.view, 0, 0, TABLE_WIDTH, TABLE_HEIGHT, "#10251F55").mouseEnabled = false;
    const panel = paperPanel(this.view, 1030, 115, 720, 850);

    label(this.view, "绵阳血战麻将", 70, { width: 900, align: "center", bold: true, color: "#F4EEDC" }).pos(90, 330);
    label(this.view, "好友相聚 · 血战到底", 30, { width: 900, align: "center", color: "#E3D4AD" }).pos(90, 430);
    label(panel, "登录", 46, { width: 720, align: "center", bold: true, color: NON_TABLE.ink }).pos(0, 55);
    label(panel, "输入邀请密钥或使用已有账号", 24, { width: 720, align: "center", color: NON_TABLE.dim }).pos(0, 120);

    this.keyInput = field(panel, 70, 195, 580, 78, "MYMJ-XXXX-XXXX-XXXX-XXXX", 32).input;
    this.keyInput.on(Laya.Event.ENTER, null, () => { void this.submit(); });

    textButton(panel, "使用邀请密钥进入", 170, 300, 380, 76, NON_TABLE.jade, () => void this.submit(), 18);

    const account = field(panel, 70, 445, 580, 76, "账号 ID", 10).input;
    const password = field(panel, 70, 545, 580, 76, "登录密码", 200).input; password.type = "password";
    textButton(panel, "账号登录", 170, 660, 380, 76, NON_TABLE.jade, () => { if (!this.busy) void this.flow.enterAccount(account.text, password.text); }, 18);

    this.errorLabel = label(panel, "", 23, { width: 620, align: "center", color: THEME.bad, wordWrap: true });
    this.errorLabel.pos(50, 770);
    this.busyLabel = label(panel, "登录中…", 23, { width: 620, align: "center", color: NON_TABLE.dim });
    this.busyLabel.pos(50, 770);
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
