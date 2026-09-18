import type { ApiClient, ClientFlow, Screen } from "@mianyang-mahjong/client";
import { ChatPage } from "./ChatPage.js";
import { HomePage } from "./HomePage.js";
import { KeyEntryPage } from "./KeyEntryPage.js";
import { ProfilePage } from "./ProfilePage.js";
import { RoomPage } from "./RoomPage.js";
import { DESIGN_HEIGHT, DESIGN_WIDTH, TABLE_HEIGHT, TABLE_WIDTH } from "./widgets.js";

interface PageView {
  readonly view: Laya.Box;
  show(screen: Screen): void;
  /** 离开页面时收尾（停止轮询等）；可以省略。 */
  hide?(): void;
}

/**
 * 把页面流产出的 `Screen` 绑到各个页面视图上。
 *
 * 渲染层不持有任何业务状态：每一帧都来自 `flow.onChange` 的 Screen 快照，
 * 页面自己只保留纯展示性的本地状态（例如结算浮层是否已被关掉）。
 */
export class ScreenHost {
  private readonly keyEntry: KeyEntryPage;
  private readonly profile: ProfilePage;
  private readonly home: HomePage;
  private readonly room: RoomPage;
  private readonly chat: ChatPage;
  /** 最近一次主页上的「我」；房间页高亮自己要用。 */
  private me: { userId: string; nickname: string; points: number } | undefined;
  private currentName: Screen["name"] | null = null;

  constructor(
    private readonly flow: ClientFlow,
    api: ApiClient,
    private readonly stage: Laya.Stage,
  ) {
    this.keyEntry = new KeyEntryPage(flow, stage);
    this.profile = new ProfilePage(flow, stage);
    this.home = new HomePage(flow, stage);
    this.room = new RoomPage(flow, api, stage, () => this.me);
    this.chat = new ChatPage(flow, stage);
    this.profile.view.visible = false;
    this.home.view.visible = false;
    this.room.view.visible = false;
    this.chat.view.visible = false;
  }

  render(screen: Screen): void {
    if (screen.name === "home") this.me = screen.me;
    if (this.currentName !== screen.name) {
      const previous = this.current;
      if (previous) {
        previous.view.visible = false;
        if (previous.hide) previous.hide();
      }
      this.currentName = screen.name;
      this.applyStageSize(screen.name);
      this.pageFor(screen.name).view.visible = true;
    }
    this.pageFor(screen.name).show(screen);
  }

  /**
   * 切换设计分辨率：大厅/登录是竖屏 750×1334，牌桌是横屏 1920×1080。
   *
   * ⚠️ `Stage.designWidth` / `designHeight` 在 LayaAir 3.4 里是**普通字段**，
   * 赋值本身不会触发任何重新布局 —— 舞台只在窗口 resize 时才算一遍。
   * 所以这里必须显式 `updateCanvasSize(true)` 让引擎按新的设计尺寸重算缩放与居中，
   * 否则切到牌桌时画面会继续按竖屏那套比例铺（只看得见左上角一块），
   * 一直要等到用户手动缩放一次窗口才「自己好了」。
   *
   * （`Main.setupStage` 那处不用补：它把 `scaleMode` 从项目配置的 `fixedheight`
   * 改成 `SCALE_SHOWALL`，那个 setter 自带重新布局。这里改设计尺寸时 `scaleMode`
   * 没变，setter 是等值判断过的，不会再触发。）
   */
  private applyStageSize(name: Screen["name"]): void {
    const landscape = name === "room";
    this.stage.designWidth = landscape ? TABLE_WIDTH : DESIGN_WIDTH;
    this.stage.designHeight = landscape ? TABLE_HEIGHT : DESIGN_HEIGHT;
    this.stage.updateCanvasSize(true);
  }

  private get current(): PageView | null {
    if (this.currentName === null) return null;
    return this.pageFor(this.currentName);
  }

  private pageFor(name: Screen["name"]): PageView {
    switch (name) {
      case "key-entry": return this.keyEntry;
      case "profile": return this.profile;
      case "home": return this.home;
      case "room": return this.room;
      case "chat": return this.chat;
    }
  }
}
