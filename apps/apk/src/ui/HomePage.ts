import type { ClientFlow, GroupSummary, MatchSummary, Screen } from "@mianyang-mahjong/client";
import { THEME, box, field, fmtDelta, label, refill, scrollList, textButton } from "./widgets.js";

const ROLE_NAMES: Record<GroupSummary["role"], string> = { owner: "群主", admin: "管理员", member: "" };

function shortDate(iso: string): string {
  const at = new Date(iso);
  const pad = (value: number): string => (value < 10 ? `0${value}` : String(value));
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** 主页：我的信息、建房/进房、群列表与战绩。 */
export class HomePage {
  readonly view: Laya.Box;
  private readonly meLabel: Laya.Label;
  private readonly roomInput: Laya.TextInput;
  private readonly errorLabel: Laya.Label;
  private readonly busyLabel: Laya.Label;
  private readonly groupList: Laya.VBox;
  private readonly matchList: Laya.VBox;
  private readonly groupEmpty: Laya.Label;
  private readonly matchEmpty: Laya.Label;
  private busy = false;

  constructor(
    private readonly flow: ClientFlow,
    parent: Laya.Stage,
  ) {
    this.view = new Laya.Box();
    this.view.size(750, 1334);
    parent.addChild(this.view);

    // 顶部：我的信息 + 登出
    const header = box(this.view, 0, 0, 750, 110, THEME.panelBg);
    this.meLabel = label(header, "", 26, { wordWrap: false });
    this.meLabel.pos(30, 40);
    textButton(header, "登出", 610, 25, 110, 60, THEME.panelBg2, () => this.flow.signOut());

    // 建房 / 进房 / 刷新
    textButton(this.view, "创建房间", 75, 150, 220, 80, THEME.accentDark, () => void this.flow.createRoom());
    this.roomInput = field(this.view, 320, 150, 240, 80, "房间号", 16).input;
    textButton(this.view, "加入", 585, 150, 90, 80, THEME.panelBg2, () => void this.joinRoom());
    textButton(this.view, "刷新列表", 75, 250, 220, 64, THEME.panelBg2, () => void this.flow.refreshHome());

    this.errorLabel = label(this.view, "", 24, { width: 600, align: "center", color: THEME.bad, wordWrap: true });
    this.errorLabel.pos(75, 330);
    this.busyLabel = label(this.view, "处理中…", 24, { width: 600, align: "center", color: THEME.textDim });
    this.busyLabel.pos(75, 330);
    this.busyLabel.visible = false;

    // 群聊列表
    label(this.view, "我的群聊", 28, { bold: true }).pos(75, 395);
    this.groupList = scrollList(this.view, 75, 440, 600, 320);
    this.groupEmpty = label(this.view, "还没有加入任何群", 24, { width: 600, align: "center", color: THEME.textDim });
    this.groupEmpty.pos(75, 580);

    // 战绩列表
    label(this.view, "最近战绩", 28, { bold: true }).pos(75, 800);
    this.matchList = scrollList(this.view, 75, 845, 600, 430);
    this.matchEmpty = label(this.view, "还没有打过牌", 24, { width: 600, align: "center", color: THEME.textDim });
    this.matchEmpty.pos(75, 1000);
  }

  show(screen: Screen): void {
    if (screen.name !== "home") return;
    this.meLabel.text = `${screen.me.nickname}  ID:${screen.me.userId}  积分:${screen.me.points}`;
    this.busy = screen.busy;
    this.busyLabel.visible = screen.busy;
    this.errorLabel.visible = !screen.busy && screen.error !== undefined;
    this.errorLabel.text = screen.error ?? "";
    this.renderGroups(screen.groups);
    this.renderMatches(screen.matches);
  }

  private async joinRoom(): Promise<void> {
    const roomId = this.roomInput.text.trim();
    if (this.busy || roomId.length === 0) return;
    await this.flow.joinRoom(roomId);
  }

  private renderGroups(groups: GroupSummary[]): void {
    this.groupEmpty.visible = groups.length === 0;
    refill(this.groupList, groups.length, (index, row) => {
      const group = groups[index]!;
      const role = ROLE_NAMES[group.role];
      const title = label(row, `${group.name}（${group.groupNo}）${role ? " · " + role : ""}`, 26, { width: 440, bold: group.role === "owner" });
      title.pos(20, 10);
      const second = group.notice.length > 0
        ? `公告：${group.notice}`
        : `${group.memberCount} 人${group.lastMessageAt ? " · 最近消息 " + shortDate(group.lastMessageAt) : ""}`;
      const detail = label(row, second, 22, { width: 440, color: THEME.textDim });
      detail.pos(20, 48);
      const enter = label(row, "进入 >", 22, { width: 110, align: "right", color: THEME.accent });
      enter.pos(470, 32);
      row.size(600, 88);
      row.bgColor = THEME.panelBg;
      // 点一行就进群聊：消息列表与实时推送都在群聊页里。
      // 写成块语句而不是 `() => void ...`：`EventDispatcher.on` 的 listener 参数类型是 `Function`，
      // 表达式体推不出返回类型，`noImplicitAny` 下会报 TS7011。
      row.on(Laya.Event.CLICK, null, () => {
        void this.flow.openChat(group.groupId);
      });
    });
  }

  private renderMatches(matches: MatchSummary[]): void {
    this.matchEmpty.visible = matches.length === 0;
    refill(this.matchList, matches.length, (index, row) => {
      const match = matches[index]!;
      const mine = match.me?.accountDelta ?? 0;
      const title = label(
        row,
        `房间 ${match.roomId} · ${match.completedRounds} 局 · ${match.finalReason === "three-winners" ? "打满" : "解散"}`,
        26,
        { width: 600 },
      );
      title.pos(20, 10);
      const detail = label(
        row,
        `我的分 ${fmtDelta(mine)}  ·  ${shortDate(match.finalizedAt)}`,
        22,
        { width: 600, color: mine >= 0 ? THEME.good : THEME.bad },
      );
      detail.pos(20, 48);
      row.size(600, 88);
      row.bgColor = THEME.panelBg;
    });
  }
}
