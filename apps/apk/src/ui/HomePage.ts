import type { ClientFlow, Screen } from "@mianyang-mahjong/client";
import { box, field, label, refill, scrollList, textButton } from "./widgets.js";
import { groupDialog, passwordDialog, socialAvatar, SOCIAL } from "./SocialDialogs.js";
export class HomePage {
  readonly view: Laya.Box;
  private readonly heading: Laya.Label;
  private readonly list: Laya.VBox;
  private readonly status: Laya.Label;
  private readonly returnButton: Laya.Box;
  constructor(private readonly flow: ClientFlow, parent: Laya.Stage) {
    this.view = box(parent, 0, 0, 750, 1334, SOCIAL.bg);
    const header = box(this.view, 0, 0, 750, 115, "#f7f7f7");
    this.heading = label(header, "大厅", 34, { color: SOCIAL.ink, bold: true }); this.heading.pos(30, 35);
    textButton(header, "创建群聊", 535, 25, 190, 65, SOCIAL.green, () => groupDialog(this.view, flow, "create"));
    textButton(this.view, "搜索群聊 · 群名称 / 群号", 25, 140, 700, 65, "#cbd5ce", () => groupDialog(this.view, flow, "search"));
    textButton(this.view, "创建房间", 25, 235, 210, 75, SOCIAL.green, () => { void flow.createRoom(); });
    const room = field(this.view, 250, 235, 285, 75, "6 位房间号", 6).input;
    textButton(this.view, "加入", 550, 235, 175, 75, SOCIAL.green, () => { void flow.joinRoom(room.text); });
    this.returnButton = textButton(this.view, "返回我的房间", 25, 330, 700, 60, SOCIAL.green, () => { void flow.rejoinActiveRoom(); });
    label(this.view, "群聊", 25, { color: SOCIAL.dim }).pos(30, 425);
    this.list = scrollList(this.view, 0, 475, 750, 660);
    this.status = label(this.view, "", 23, { width: 690, color: "#9e5942", wordWrap: true }); this.status.pos(30, 1145);
    textButton(this.view, "设置登录密码", 25, 1240, 245, 65, SOCIAL.green, () => passwordDialog(this.view, flow));
    textButton(this.view, "刷新", 290, 1240, 185, 65, "#788d7e", () => { void flow.refreshHome(); });
    textButton(this.view, "退出登录", 495, 1240, 230, 65, "#788d7e", () => flow.signOut());
  }
  show(screen: Screen): void {
    if (screen.name !== "home") return;
    this.heading.text = `大厅 · ${screen.me.nickname}`;
    this.returnButton.visible = !!screen.activeRoom;
    this.status.text = screen.error ?? `账号 ${screen.me.userId} · ${screen.me.points} 分`;
    refill(this.list, screen.groups.length || 1, (index, row) => {
      const group = screen.groups[index]; row.size(750, 115); row.bgColor = SOCIAL.panel;
      if (!group) { label(row, "还没有群聊，创建或搜索群聊开始聊天", 25, { color: SOCIAL.dim }).pos(30, 40); return; }
      socialAvatar(row, group.name, undefined, 25, 22);
      label(row, group.name, 29, { width: 510, color: SOCIAL.ink }).pos(120, 22);
      label(row, group.notice || `${group.memberCount} 位牌友 · 群号 ${group.groupNo}`, 22, { width: 600, color: SOCIAL.dim }).pos(120, 65);
      row.on(Laya.Event.CLICK, null, () => { void this.flow.openChat(group.groupId); });
    });
  }
}
