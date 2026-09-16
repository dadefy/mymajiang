import { ClientFlow, type Screen } from "../flow.js";
import { ApiClient } from "../api-client.js";
import type { MatchState, RoomResult, Suit, Tile } from "../protocol.js";
import { BrowserSocketTransportFactory, FetchHttpTransport } from "./transports.js";

/**
 * 给内部联网测试用的浏览器调试客户端。
 *
 * 它**不是**要取代 LayaAir 那一版 —— 那一版才是最终给玩家用的 APK。
 * 这一版的目的只有一个：让内网里的人**今天就能打开一个网址开始打牌**，
 * 不需要 Android 工具链、不需要打包、不需要上架。
 *
 * 它复用 `ClientFlow`（已经过单元测试的业务层），所以页面流转、断线重连、
 * 令牌持有这些逻辑与最终版本完全一致 —— 换渲染层时业务行为不会变。
 */

interface RuntimeConfig {
  apiBaseUrl: string;
  socketUrl: string;
}

const SUIT_LABEL: Record<Suit, string> = { wan: "万", tong: "筒", tiao: "条" };

/** 牌面文字。牌的编号是 0..26：0-8 万、9-17 筒、18-26 条。 */
function tileLabel(tile: Tile): string {
  const suit = (["wan", "tong", "tiao"] as const)[Math.floor(tile / 9)] ?? "wan";
  return `${(tile % 9) + 1}${SUIT_LABEL[suit]}`;
}

/**
 * 配置来源：服务端注入的 `window.__MYMJ_CONFIG__`，没有就按同源推断。
 *
 * 单端口部署时页面与接口同源，直接用 `location.origin` 推出实时通道地址即可：
 * `https://x` → `wss://x`、`http://x:3000` → `ws://x:3000`。
 * 这样**隧道、反向代理、HTTPS 全都自动正确** —— 换成 `wss://` 是浏览器对
 * HTTPS 页面的硬要求（混合内容会被拦截），同源推导天然满足。
 */
function config(): RuntimeConfig {
  const injected = (globalThis as { __MYMJ_CONFIG__?: Partial<RuntimeConfig> }).__MYMJ_CONFIG__ ?? {};
  const origin = location.origin;
  return {
    apiBaseUrl: injected.apiBaseUrl ?? origin,
    socketUrl: injected.socketUrl || origin.replace(/^http/, "ws"),
  };
}

const runtime = config();
const api = new ApiClient(new FetchHttpTransport(runtime.apiBaseUrl));
const flow = new ClientFlow(api, new BrowserSocketTransportFactory(), runtime.socketUrl);

// ---------- 小工具 ----------

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: { text?: string; className?: string; onClick?: () => void } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.text !== undefined) node.textContent = options.text;
  if (options.className) node.className = options.className;
  if (options.onClick) node.addEventListener("click", options.onClick);
  if (children.length > 0) node.append(...children);
  return node;
}

function button(label: string, onClick: () => void, className = ""): HTMLButtonElement {
  return element("button", { text: label, className, onClick });
}

function panel(title: string, ...children: HTMLElement[]): HTMLElement {
  const box = element("section", { className: "panel" });
  box.append(element("h2", { text: title }), ...children);
  return box;
}

const app = document.querySelector<HTMLDivElement>("#app")!;
const bar = document.querySelector<HTMLDivElement>("#bar")!;

/** 手动换三张时已选中的牌。 */
let selected: Tile[] = [];

// ---------- 渲染 ----------

function render(screen: Screen): void {
  app.replaceChildren();
  renderBar(screen);
  switch (screen.name) {
    case "key-entry": return renderKeyEntry(screen);
    case "profile": return renderProfile(screen);
    case "home": return renderHome(screen);
    case "room": return renderRoom(screen);
  }
}

function renderBar(screen: Screen): void {
  bar.replaceChildren();
  if (screen.name === "home") {
    bar.append(
      element("span", { text: `${screen.me.nickname}（${screen.me.userId}）积分 ${screen.me.points}` }),
      element("span", { className: "spacer" }),
      button("刷新", () => void flow.refreshHome()),
      button("退出登录", () => flow.signOut()),
    );
  } else if (screen.name === "room") {
    bar.append(
      element("span", { text: `房间 ${screen.roomId}` }),
      element("span", { className: "spacer" }),
      button("离开房间", () => void flow.leaveRoom()),
    );
  } else {
    bar.append(element("span", { text: "绵阳血战麻将 · 内测调试客户端" }));
  }
}

function errorLine(message: string | undefined): HTMLElement | null {
  return message ? element("p", { className: "error", text: message }) : null;
}

function renderKeyEntry(screen: Extract<Screen, { name: "key-entry" }>): void {
  const input = element("input", { className: "text" });
  input.placeholder = "MYMJ-XXXX-XXXX-XXXX-XXXX";
  const submit = button("进入", () => void flow.enterKey(input.value), "primary");
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void flow.enterKey(input.value);
  });
  app.append(panel("输入邀请密钥",
    input,
    element("div", { className: "row" }, submit),
    ...(errorLine(screen.error) ? [errorLine(screen.error)!] : []),
    element("p", { className: "hint", text: "第一次用这把密钥会进入资料页填写昵称；之后同一把密钥直接进主页。" }),
  ));
}

function renderProfile(screen: Extract<Screen, { name: "profile" }>): void {
  const nickname = element("input", { className: "text" });
  nickname.placeholder = "昵称";
  const avatar = element("input", { className: "text" });
  avatar.placeholder = "头像地址（随便填一个 URL 即可）";
  avatar.value = "https://example.invalid/avatar.png";
  app.append(panel("完善资料",
    element("p", { className: "hint", text: `密钥 ${screen.key}` }),
    nickname,
    avatar,
    element("div", { className: "row" }, button("创建账号", () => void flow.submitProfile(screen.key, nickname.value, avatar.value), "primary")),
    ...(errorLine(screen.error) ? [errorLine(screen.error)!] : []),
  ));
}

function renderHome(screen: Extract<Screen, { name: "home" }>): void {
  const joinInput = element("input", { className: "text" });
  joinInput.placeholder = "房间 ID（别人建房后告诉你）";

  app.append(
    panel("开始打牌",
      element("div", { className: "row" },
        button("建一个新房间", () => void flow.createRoom(), "primary"),
        joinInput,
        button("加入", () => void flow.joinRoom(joinInput.value.trim())),
      ),
      ...(errorLine(screen.error) ? [errorLine(screen.error)!] : []),
    ),
    renderGroups(screen),
    renderMatches(screen),
  );
}

function renderGroups(screen: Extract<Screen, { name: "home" }>): HTMLElement {
  const list = element("div", { className: "list" });
  if (screen.groups.length === 0) {
    list.append(element("p", { className: "hint", text: "还没有加入任何群聊。" }));
  }
  for (const group of screen.groups) {
    const messages = element("div", { className: "messages" });
    const input = element("input", { className: "text" });
    input.placeholder = "发一条消息";
    const load = async (): Promise<void> => {
      const result = await flow.groupMessages(group.groupId, 30);
      messages.replaceChildren();
      if (!result.ok) {
        messages.append(element("p", { className: "error", text: "拉取消息失败" }));
        return;
      }
      for (const message of result.value.messages) {
        messages.append(element("p", { text: `${message.senderId}: ${message.content}` }));
      }
      messages.scrollTop = messages.scrollHeight;
    };
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || !input.value.trim()) return;
      const content = input.value;
      input.value = "";
      void flow.sendGroupText(group.groupId, content).then(load);
    });

    list.append(element("div", { className: "group" },
      element("div", { className: "row" },
        element("strong", { text: group.name }),
        element("span", { className: "hint", text: `号 ${group.groupNo} · ${group.memberCount} 人` }),
        element("span", { className: "spacer" }),
        button("加载消息", () => void load()),
      ),
      messages,
      input,
    ));
  }
  return panel("群聊", list);
}

function renderMatches(screen: Extract<Screen, { name: "home" }>): HTMLElement {
  const list = element("div", { className: "list" });
  if (screen.matches.length === 0) {
    list.append(element("p", { className: "hint", text: "还没有战绩。" }));
  }
  for (const match of screen.matches) {
    const mine = match.me ? `我 ${match.me.accountDelta >= 0 ? "+" : ""}${match.me.accountDelta}` : "没参加";
    list.append(element("p", {
      text: `${match.roomId} · ${match.completedRounds} 局 · ${match.finalReason} · ${mine}`,
    }));
  }
  return panel("我的战绩", list);
}

function renderRoom(screen: Extract<Screen, { name: "room" }>): void {
  const snapshot = screen.snapshot;
  const players = element("div", { className: "list" });
  if (snapshot) {
    for (const player of snapshot.players) {
      players.append(element("p", {
        text: `${player.nickname}（${player.userId}）· 积分 ${player.points} · ${player.ready ? "已准备" : "未准备"} · ${player.connected ? "在线" : "离线"}`,
      }));
    }
  }

  const controls = element("div", { className: "row" });
  if (snapshot?.status === "waiting") {
    controls.append(
      button("我准备好了", () => void flow.setReady(true)),
      button("取消准备", () => void flow.setReady(false)),
      button("开始对局（房主）", () => void flow.startMatch(), "primary"),
    );
  }

  app.append(
    panel(`房间（${snapshot?.status ?? "连接中"}）${snapshot ? ` · 已打 ${snapshot.completedRounds} 局` : ""}`,
      players,
      controls,
      ...(screen.notice ? [element("p", { className: "hint", text: screen.notice })] : []),
    ),
  );

  if (screen.match) app.append(renderTable(screen.match, screen.actions));
  if (screen.lastResult) app.append(renderResult(screen.lastResult));
}

function renderTable(match: MatchState, actions: string[]): HTMLElement {
  const box = panel(`第 ${match.roundNumber} 局 · ${phaseLabel(match.phase)} · 我坐 ${match.seat} 号位 · 牌墙剩 ${match.tilesLeft}`);

  // 其它三家的概况：只给张数与副露，这是服务端脱敏后能给的。
  for (const player of match.players) {
    if (player.seat === match.seat) continue;
    box.append(element("p", { className: "hint", text:
      `${player.seat} 号位：手牌 ${player.handSize} 张 · 副露 ${player.melds.length} · 缺 ${player.missingSuit ? SUIT_LABEL[player.missingSuit] : "未定"} · 已出 ${player.discards.map(tileLabel).join(" ")}` }));
  }

  // 我的手牌：换三张阶段可点选，行牌阶段点击即出牌。
  const hand = element("div", { className: "hand" });
  for (const tile of match.hand) {
    const chosen = selected.includes(tile);
    const node = element("button", {
      text: tileLabel(tile),
      className: `tile${chosen ? " chosen" : ""}`,
      onClick: () => {
        if (match.phase === "swapping") {
          // 选满三张就替换最早选的那张，避免用户点第四张时不知所措。
          if (selected.includes(tile)) selected = selected.filter((each) => each !== tile);
          else selected = [...selected, tile].slice(-3);
          render(flow.current);
        } else if (match.phase === "playing" || match.phase === "claiming") {
          flow.discard(tile);
        }
      },
    });
    if (match.missingSuit) {
      const suit = (["wan", "tong", "tiao"] as const)[Math.floor(tile / 9)];
      if (suit === match.missingSuit) node.classList.add("missing-suit");
    }
    hand.append(node);
  }

  const row = element("div", { className: "row" });
  if (match.phase === "swapping") {
    row.append(
      button(`换这三张（已选 ${selected.length}/3）`, () => {
        if (selected.length !== 3) return;
        flow.swap([...selected]);
        selected = [];
      }, "primary"),
      button("自动换三张", () => { selected = []; flow.autoSwap(); }),
    );
  }
  if (match.phase === "missing") {
    for (const suit of ["wan", "tong", "tiao"] as const) {
      row.append(button(`定缺 ${SUIT_LABEL[suit]}`, () => flow.chooseMissing(suit as Suit)));
    }
    row.append(button("自动定缺", () => flow.autoMissing()));
  }
  if (actions.includes("hu")) row.append(button("胡", () => flow.claim("hu"), "primary"));
  if (actions.includes("peng")) row.append(button("碰", () => flow.claim("peng")));
  if (actions.includes("kong")) row.append(button("杠", () => flow.claim("kong")));
  if (actions.includes("pass")) row.append(button("过", () => flow.claim("pass")));
  if (actions.includes("self-draw")) row.append(button("自摸", () => flow.selfDraw(), "primary"));
  if (actions.includes("concealed-kong")) row.append(button("暗杠", () => flow.concealedKong()));
  if (actions.includes("added-kong")) row.append(button("补杠", () => flow.addedKong()));

  box.append(hand, row, element("p", { className: "hint", text: `我的副露：${match.melds.map((meld) => `${meld.kind}${tileLabel(meld.tile)}`).join(" ") || "无"}` }),
    element("p", { className: "hint", text: `我已出：${match.discards.map(tileLabel).join(" ") || "无"}` }));
  return box;
}

function renderResult(result: RoomResult): HTMLElement {
  const lines = result.deltas.map((delta) => `${delta.playerId} ${delta.delta >= 0 ? "+" : ""}${delta.delta}`);
  return panel(`上一局结算（${result.reason}）`,
    element("p", { text: `赢家座位：${result.winnerSeats.join("、") || "无"}` }),
    element("p", { text: lines.join("　") }),
  );
}

function phaseLabel(phase: MatchState["phase"]): string {
  return { swapping: "换三张", missing: "定缺", playing: "行牌", claiming: "等待别人确认", finished: "本局结束" }[phase];
}

flow.onChange(render);
render(flow.current);
