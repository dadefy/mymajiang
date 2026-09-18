import type { ClientFlow, Screen } from "@mianyang-mahjong/client";
import type { PresentationControls } from "../presentation/presentation.js";
import { groupDialog, passwordDialog, socialAvatar } from "./SocialDialogs.js";
import { NON_TABLE, background, clear, pageTitle, paperPanel } from "./non-table-skin.js";
import { box, field, fmtDelta, label, textButton } from "./widgets.js";

type HomeScreen = Extract<Screen, { name: "home" }>;
type Tab = "lobby" | "groups" | "matches" | "profile" | "settings";

/** 横屏正式大厅。业务数据只读 ClientFlow 的 Screen，页面只保存当前页签和弹层。 */
export class HomePage {
  readonly view: Laya.Box;
  private readonly content: Laya.Box;
  private readonly status: Laya.Label;
  private screen: HomeScreen | null = null;
  private tab: Tab = "lobby";
  private modal: Laya.Box | null = null;

  constructor(private readonly flow: ClientFlow, parent: Laya.Stage, private readonly controls: PresentationControls) {
    this.view = box(parent, 0, 0, NON_TABLE.width, NON_TABLE.height);
    background(this.view, "lobby");
    const veil = box(this.view, 0, 0, NON_TABLE.width, NON_TABLE.height, "#F4EEDC77"); veil.mouseEnabled = false;
    pageTitle(this.view, "绵阳血战麻将", "好友相聚 · 服务器权威牌局");
    const nav = paperPanel(this.view, 72, 178, 300, 790);
    const entries: Array<[Tab, string]> = [["lobby", "游戏大厅"], ["groups", "牌友群"], ["matches", "战绩"], ["profile", "个人中心"], ["settings", "设置"]];
    entries.forEach(([key, text], i) => textButton(nav, text, 25, 40 + i * 100, 250, 72, key === "lobby" ? NON_TABLE.jade : "#789084", () => this.switchTab(key), 18));
    textButton(nav, "刷新数据", 25, 600, 250, 64, "#789084", () => void flow.refreshHome(), 16);
    textButton(nav, "退出登录", 25, 690, 250, 64, "#8C6458", () => flow.signOut(), 16);
    paperPanel(this.view, 402, 178, 1440, 790);
    this.content = box(this.view, 432, 208, 1380, 710);
    this.status = label(this.view, "", 22, { width: 1380, color: "#8E4E3D", align: "right" }); this.status.pos(432, 932);
  }

  show(screen: Screen): void {
    if (screen.name !== "home") return;
    this.screen = screen;
    this.status.text = screen.error ?? (screen.busy ? "正在刷新…" : `账号 ${screen.me.userId} · 当前积分 ${screen.me.points}`);
    this.render();
  }

  private switchTab(tab: Tab): void { this.tab = tab; this.closeModal(); this.render(); }

  private render(): void {
    if (!this.screen) return;
    clear(this.content);
    if (this.tab === "lobby") this.lobby(this.screen);
    else if (this.tab === "groups") this.groups(this.screen);
    else if (this.tab === "matches") this.matches(this.screen);
    else if (this.tab === "profile") this.profile(this.screen);
    else this.settings();
  }

  private lobby(screen: HomeScreen): void {
    label(this.content, `欢迎回来，${screen.me.nickname}`, 42, { color: NON_TABLE.ink, bold: true }).pos(20, 18);
    label(this.content, `积分 ${screen.me.points}`, 26, { color: NON_TABLE.gold }).pos(22, 78);
    textButton(this.content, "创建房间", 20, 160, 390, 130, NON_TABLE.jade, () => this.createDialog(), 26);
    textButton(this.content, "加入房间", 445, 160, 390, 130, "#527F72", () => this.joinDialog(), 26);
    textButton(this.content, "牌友群", 870, 160, 390, 130, "#7B8761", () => this.switchTab("groups"), 26);
    if (screen.activeRoom) {
      const room = screen.activeRoom;
      label(this.content, `进行中的房间 ${room.roomNo}`, 28, { color: NON_TABLE.ink, bold: true }).pos(22, 350);
      label(this.content, `${room.playerCount}/4 人 · ${room.status === "waiting" ? "等待开始" : "牌局进行中"}`, 22, { color: NON_TABLE.dim }).pos(22, 398);
      textButton(this.content, "回到房间", 930, 340, 330, 82, NON_TABLE.jade, () => void this.flow.rejoinActiveRoom(), 18);
    } else label(this.content, "当前没有进行中的房间", 25, { color: NON_TABLE.dim }).pos(22, 370);
    label(this.content, "四人血战到底 · 共 8 小局", 28, { color: NON_TABLE.ink, bold: true }).pos(22, 510);
    label(this.content, "规则、发牌、胡牌与计分均由服务器确认。客户端只负责展示与输入。", 23, { width: 1220, color: NON_TABLE.dim, wordWrap: true }).pos(22, 562);
  }

  private groups(screen: HomeScreen): void {
    label(this.content, "牌友群", 38, { color: NON_TABLE.ink, bold: true }).pos(20, 12);
    textButton(this.content, "创建群", 940, 0, 150, 64, NON_TABLE.jade, () => groupDialog(this.view, this.flow, "create"), 16);
    textButton(this.content, "搜索群", 1110, 0, 150, 64, "#68887B", () => groupDialog(this.view, this.flow, "search"), 16);
    if (!screen.groups.length) { label(this.content, "还没有群聊，创建或搜索群聊开始聊天", 26, { width: 1260, align: "center", color: NON_TABLE.dim }).pos(0, 300); return; }
    screen.groups.slice(0, 5).forEach((group, i) => {
      const row = box(this.content, 10, 92 + i * 112, 1250, 94, i % 2 ? "#E5E1D2" : "#EEE8D7");
      socialAvatar(row, group.name, undefined, 18, 12);
      label(row, group.name, 27, { color: NON_TABLE.ink, bold: true }).pos(106, 14);
      label(row, group.notice || `${group.memberCount} 位牌友 · 群号 ${group.groupNo}`, 20, { width: 850, color: NON_TABLE.dim }).pos(106, 54);
      textButton(row, "进入群聊", 1030, 16, 190, 62, NON_TABLE.jade, () => void this.flow.openChat(group.groupId), 14);
    });
  }

  private matches(screen: HomeScreen): void {
    label(this.content, "最近战绩", 38, { color: NON_TABLE.ink, bold: true }).pos(20, 12);
    if (screen.matchesUnavailable || !screen.matches.length) { label(this.content, screen.matchesUnavailable ? "当前服务器未启用战绩存储" : "还没有已完成的牌局", 27, { width: 1260, align: "center", color: NON_TABLE.dim }).pos(0, 310); return; }
    screen.matches.slice(0, 6).forEach((match, i) => {
      const row = box(this.content, 10, 88 + i * 96, 1250, 78, i % 2 ? "#E5E1D2" : "#EEE8D7");
      label(row, `房间 ${match.roomId.slice(0, 8)} · ${match.completedRounds} 局`, 23, { color: NON_TABLE.ink }).pos(18, 14);
      label(row, new Date(match.finalizedAt).toLocaleString(), 18, { color: NON_TABLE.dim }).pos(18, 48);
      const delta = match.me?.rawDelta ?? 0;
      label(row, fmtDelta(delta), 32, { width: 170, align: "right", color: delta >= 0 ? "#247A59" : "#A04B42", bold: true }).pos(1040, 22);
    });
  }

  private profile(screen: HomeScreen): void {
    label(this.content, "个人中心", 38, { color: NON_TABLE.ink, bold: true }).pos(20, 12);
    socialAvatar(this.content, screen.me.nickname, undefined, 35, 110);
    label(this.content, screen.me.nickname, 38, { color: NON_TABLE.ink, bold: true }).pos(160, 115);
    label(this.content, `账号 ID：${screen.me.userId}`, 24, { color: NON_TABLE.dim }).pos(160, 178);
    label(this.content, `当前积分：${screen.me.points}`, 30, { color: NON_TABLE.gold, bold: true }).pos(160, 230);
    textButton(this.content, "设置登录密码", 35, 360, 310, 76, NON_TABLE.jade, () => passwordDialog(this.view, this.flow), 18);
    label(this.content, "昵称、账号和积分均来自当前账号；不展示未实现的等级、金币或 VIP。", 22, { width: 1000, color: NON_TABLE.dim, wordWrap: true }).pos(35, 490);
  }

  private settings(): void {
    const s = this.controls.getSettings();
    label(this.content, "声音与表现", 38, { color: NON_TABLE.ink, bold: true }).pos(20, 12);
    this.volume("音乐", s.musicVolume, 110, (v) => this.controls.setMusicVolume(v));
    this.volume("音效", s.effectsVolume, 220, (v) => this.controls.setSfxVolume(v));
    this.volume("语音", s.voiceVolume, 330, (v) => this.controls.setVoiceVolume(v));
    textButton(this.content, s.masterMuted ? "取消静音" : "全部静音", 20, 470, 280, 76, s.masterMuted ? NON_TABLE.jade : "#8C6458", () => { s.masterMuted ? this.controls.unmute() : this.controls.mute(); this.render(); }, 18);
    textButton(this.content, "开启动画", 330, 470, 240, 76, "#68887B", () => this.controls.setAnimationsEnabled(true), 18);
    textButton(this.content, "关闭动画", 590, 470, 240, 76, "#879B8E", () => this.controls.setAnimationsEnabled(false), 18);
  }

  private volume(name: string, value: number, y: number, apply: (v: number) => void): void {
    label(this.content, name, 28, { width: 180, color: NON_TABLE.ink, bold: true }).pos(22, y + 18);
    label(this.content, `${Math.round(value * 100)}%`, 26, { width: 150, align: "center", color: NON_TABLE.gold }).pos(210, y + 18);
    textButton(this.content, "－", 390, y, 90, 66, "#879B8E", () => { apply(Math.max(0, value - .1)); this.render(); }, 16);
    textButton(this.content, "＋", 500, y, 90, 66, NON_TABLE.jade, () => { apply(Math.min(1, value + .1)); this.render(); }, 16);
  }

  private createDialog(): void { this.simpleDialog("创建房间", "服务器将按当前正式规则创建房间。", "立即创建", () => void this.flow.createRoom()); }
  private joinDialog(): void {
    this.closeModal(); const modal = box(this.view, 0, 0, NON_TABLE.width, NON_TABLE.height, "#10251FCC"); const panel = paperPanel(modal, 590, 300, 740, 440);
    label(panel, "加入房间", 40, { width: 740, align: "center", color: NON_TABLE.ink, bold: true }).pos(0, 55);
    const input = field(panel, 130, 145, 480, 78, "请输入 6 位房间号", 6).input;
    textButton(panel, "取消", 130, 285, 220, 76, "#879B8E", () => this.closeModal(), 18);
    textButton(panel, "加入", 390, 285, 220, 76, NON_TABLE.jade, () => { this.closeModal(); void this.flow.joinRoom(input.text); }, 18); this.modal = modal;
  }
  private simpleDialog(title: string, message: string, action: string, run: () => void): void {
    this.closeModal(); const modal = box(this.view, 0, 0, NON_TABLE.width, NON_TABLE.height, "#10251FCC"); const panel = paperPanel(modal, 590, 300, 740, 440);
    label(panel, title, 40, { width: 740, align: "center", color: NON_TABLE.ink, bold: true }).pos(0, 55);
    label(panel, message, 24, { width: 620, align: "center", color: NON_TABLE.dim, wordWrap: true }).pos(60, 145);
    textButton(panel, "取消", 130, 285, 220, 76, "#879B8E", () => this.closeModal(), 18);
    textButton(panel, action, 390, 285, 220, 76, NON_TABLE.jade, () => { this.closeModal(); run(); }, 18); this.modal = modal;
  }
  private closeModal(): void { this.modal?.destroy(true); this.modal = null; }
}
