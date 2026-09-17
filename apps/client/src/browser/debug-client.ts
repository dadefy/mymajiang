import { lobby, chat, avatar, shareDialog } from "./lobby.js";
import { SingleTable } from "./single-table.js";
import { quitConfirmOverlay, tableMenuOverlay, trusteeOverlay } from "./table-menu.js";

import { roundScorePop } from "./round-result.js";
import { matchResultPanel } from "./match-result.js";
import { ClientFlow, type Screen } from "../flow.js";
import { ApiClient } from "../api-client.js";

import { button, element } from "./dom.js";
import { readRuntimeConfig } from "./runtime-config.js";
import { roundResultText } from "./result-text.js";



import { BrowserSocketTransportFactory, FetchHttpTransport, FetchUploadTransport } from "./transports.js";

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

const runtime = readRuntimeConfig();
const api = new ApiClient(new FetchHttpTransport(runtime.apiBaseUrl));
const flow = new ClientFlow(api, new BrowserSocketTransportFactory(), runtime.socketUrl, new FetchUploadTransport());

// ---------- 小工具 ----------

function panel(title: string, ...children: HTMLElement[]): HTMLElement {
  const box = element("section", { className: "panel" });
  box.append(element("h2", { text: title }), ...children);
  return box;
}

const app = document.querySelector<HTMLDivElement>("#app")!;
const bar = document.querySelector<HTMLDivElement>("#bar")!;

/**
 * 牌桌菜单与二次确认是否展开。
 *
 * 渲染是"每次重画整棵树"，没有组件局部状态，所以这两个开关放在模块级。
 * 两者互斥：打开退出确认时菜单先收起来，免得两层遮罩叠着。
 */
let tableMenuOpen = false;
let quitConfirmOpen = false;

const table = new SingleTable();
document.title = "绵阳麻将 · 大厅";

// ---------- 渲染 ----------

/** 房间快照的轮询定时器：等待期的成员与准备变化不走实时通道，只能定时拉。 */
let roomPollTimer: ReturnType<typeof setInterval> | undefined;

/** 进房间开始轮询、离开房间停掉（LayaAir 那边的房间页也是这么做的）。 */
function syncRoomPolling(inRoom: boolean): void {
  if (inRoom && roomPollTimer === undefined) {
    roomPollTimer = setInterval(() => { void flow.refreshRoom(); }, 2500);
    return;
  }
  if (!inRoom && roomPollTimer !== undefined) {
    clearInterval(roomPollTimer);
    roomPollTimer = undefined;
  }
}

function render(screen: Screen): void {
  table.dispose();
  // 离开牌桌页就把菜单/确认收起来：它们是牌桌上的浮层，留着会让下次进来时莫名其妙弹着。
  if (screen.name !== "room") {
    tableMenuOpen = false;
    quitConfirmOpen = false;
  }
  if (screen.name === "chat") { renderBar(screen); syncRoomPolling(false); const node = chat(screen, flow); if (app.firstChild !== node) app.replaceChildren(node); return; }
  app.replaceChildren();
  // 每次重画都先解绑：渲染层自己再登记（否则会指向已经卸载的那份 DOM）。
  renderBar(screen);
  syncRoomPolling(screen.name === "room");
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
    // 给人看、给人念的是 6 位房间号；内部 roomId 在房间页里另有一处（调试用）。
    bar.append(element("span", { text: `房间号 ${screen.roomNo ?? "读取中…"}` }), element("span", { className: "spacer" }));
    if (screen.match) {
      // 牌局进行中：离开牌桌的动作收进「菜单」，避免误触。
      // 「退出房间」在这一阶段本来就被服务端拒绝（规则不允许中途走人），所以不摆出来。
      bar.append(
        button("分享名片", () => shareDialog(flow)),
        button("菜单", () => {
          tableMenuOpen = !tableMenuOpen;
          quitConfirmOpen = false;
          render(flow.current);
        }, tableMenuOpen ? "primary" : ""),
      );
    } else {
      // 还没开局：这时候"退出房间"是合法的，返回大厅也只是等人期间的往返。
      bar.append(
        button("分享名片", () => shareDialog(flow)),
        button("返回大厅", () => void flow.backHome()),
        button("退出房间", () => void flow.leaveRoom()),
      );
    }
  } else {
    bar.append(element("span", { text: "绵阳血战麻将 · 单人牌桌" }));
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
  const account = element("input", { className: "text" }); account.placeholder = "账号 ID"; account.autocomplete = "username";
  const password = element("input", { className: "text" }); password.type = "password"; password.placeholder = "登录密码"; password.autocomplete = "current-password";
  app.append(panel("账号登录", account, password, button("登录大厅", () => void flow.enterAccount(account.value, password.value), "primary")));
  app.append(panel("密钥登录",
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
  app.append(lobby(screen, flow));
}

function renderRoom(screen: Extract<Screen, { name: "room" }>): void {
  const snapshot = screen.snapshot;
  if (!screen.match) {
    const board = element("div", { className: "waiting-table" });
    const mine = snapshot?.players.findIndex((player) => player.userId === flow.currentUserId) ?? 0;
    const directions = ["south", "east", "north", "west"];
    for (let index = 0; index < 4; index++) {
      const player = snapshot?.players[(Math.max(mine, 0) + index) % 4];
      const seat = element("div", { className: `waiting-seat ${directions[index]}` });
      if (player) seat.append(avatar(player.nickname, player.avatarUrl), element("strong", { text: player.nickname }), element("small", { text: `ID ${player.userId}` }), ...(player.userId === snapshot?.ownerId ? [element("span", { className: "owner-badge", text: "房主" })] : []));
      else seat.append(avatar("＋"), element("span", { text: "等待入座" }));
      board.append(seat);
    }
    const count = snapshot?.players.length ?? 0;
    const center = element("div", { className: "waiting-center" }, element("h2", { text: `房间 ${screen.roomNo ?? "…"}` }), element("p", { text: `${count}/4 人 · 绵阳血战麻将` }));
    if (snapshot?.ownerId === flow.currentUserId && snapshot?.status === "waiting") {
      const start = button("开始游戏", () => void flow.startMatch(), "primary"); start.disabled = count !== 4; center.append(start);
    }
    center.append(element("p", { className: "hint", text: count < 4 ? `还差 ${4 - count} 位牌友` : "四人已到齐，等待房主开始" }), button("邀请牌友", () => shareDialog(flow)));
    board.append(center); app.append(board);
    if (screen.notice) app.append(element("p", { className: "error", text: screen.notice }));
  }

  if (screen.match) {
    const board = table.render(screen, flow, () => render(flow.current));
    app.append(board);
    // 三个遮罩都挂进牌桌（`#board` 是定位容器），这样它们正好盖在牌桌上而不是页面别处。
    // 托管浮层在最下层、菜单/确认在其上 —— 托管中也能打开菜单（那时唯一的出路是重新接管）。
    if (screen.match.control === "trustee") {
      board.append(trusteeOverlay({
        roundNumber: screen.match.roundNumber,
        // 共几小场由服务端下发，这里不硬编一个 8
        totalRounds: screen.match.totalRounds ?? 8,
        onTakeover: () => flow.requestTakeover(),
      }));
    }
    if (tableMenuOpen) {
      board.append(tableMenuOverlay({
        onResume: () => { tableMenuOpen = false; render(flow.current); },
        onBackToLobby: () => { tableMenuOpen = false; void flow.backHome(); },
        onQuit: () => { tableMenuOpen = false; quitConfirmOpen = true; render(flow.current); },
      }));
    }
    if (quitConfirmOpen) {
      board.append(quitConfirmOverlay({
        onCancel: () => { quitConfirmOpen = false; render(flow.current); },
        onConfirm: () => {
          quitConfirmOpen = false;
          // 服务端接管后会把控制权随下一帧下发，界面据此切成「托管中 + 重新接管」。
          flow.quitGame();
          render(flow.current);
        },
      }));
    }
    if (screen.notice) app.append(element("p", { className: "hint", text: screen.notice }));
  }
  // 那一屏数字只在**局间**显示（服务端给的停留时长内）。新一小场已经开始时退化成摘要行：
  // 服务端一小场结束就开下一小场，`lastResult` 在新局里依然有值，只看它会让
  // 上一小场的数字一直压在新牌局上面（与 /multi 同一处坑）。
  // 局间的可靠信号是 `roundFinished`（收到结算帧、还没等到新一小场的第一帧），
  // **不是** `match.phase === "finished"` —— 服务端一小场结束时只发结算帧、不发 game 帧，
  // 客户端的 match 永远停在结束之前的状态，那个判据一次都不会成立。
  const roundOver = screen.match === null || screen.roundFinished;
  // 数字到点自动收（服务端给的停留时长）之后要**重画一次**：打满 8 小场时接着要显示
  // 整局结算记录，而那一刻服务端已经不再发帧，没人重画的话结算记录永远不出现。
  const repaint = (): void => {
    const current = flow.current;
    if (current.name === "room") render(current);
  };
  // 显示到 `roundPopUntil` 为止；没有时限就一直显示到新一局的 `game` 帧把 `roundOver` 清掉。
  // ⚠️ `match-finished` 之后这个值仍然有（见 flow 里的说明）—— 最后一小场那屏靠它
  // 放满停留时长，然后交接给结算记录。
  const popUntil = screen.roundPopUntil;
  const popping = screen.lastResult !== null && roundOver && (popUntil === null || Date.now() < popUntil);
  if (popping && screen.lastResult) {
    // 只在牌桌上弹四个数字：不弹面板、不亮牌面、不写牌型（见 `round-result.ts`）。
    (app.querySelector("#board") ?? app).append(roundScorePop(screen.lastResult, screen.snapshot, popUntil, repaint));
  } else {
    if (screen.lastResult) {
      // 数字收掉之后留一行摘要（各家得失分与谁胡了），牌型明细不在这屏出现。
      const summary = panel("上一小场");
      summary.append(element("p", { className: "hint", text: roundResultText(screen.lastResult, screen.snapshot) }));
      app.append(summary);
    }
    // 结算记录与上面那块分开：它的形状来自域包（`rawDeltas` + `accountDeltas`），
    // 与单局的 `deltas` 完全不同（见 result-text.ts）。
    // 「知道了」必须清**状态**（`lastMatchResult` → null），不能只摘 DOM ——
    // 否则下一次重画面板又回来了（实测「返回大厅再进房」才能清掉）。
    if (screen.lastMatchResult) {
      app.append(matchResultPanel(screen.lastMatchResult, screen.snapshot, screen.lastResult, () => flow.dismissMatchResult()));
    }
  }
}

flow.onChange(render);
render(flow.current);
