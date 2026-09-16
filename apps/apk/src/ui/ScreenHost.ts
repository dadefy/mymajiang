import type { ApiClient, ClientFlow, Screen } from "@mianyang-mahjong/client";
import { ChatPage } from "./ChatPage.js";
import { HomePage } from "./HomePage.js";
import { KeyEntryPage } from "./KeyEntryPage.js";
import { ProfilePage } from "./ProfilePage.js";
import { RoomPage } from "./RoomPage.js";

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
    stage: Laya.Stage,
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
      this.pageFor(screen.name).view.visible = true;
    }
    this.pageFor(screen.name).show(screen);
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
