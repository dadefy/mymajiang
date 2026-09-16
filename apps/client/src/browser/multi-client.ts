import { DiscardSelection } from "./discard-selection.js";
import { playerProfile } from "./player-profile.js";
import { installTableLayout } from "./table-layout.js";
import { SwapSelection } from "./swap-selection.js";
import { roundScorePop } from "./round-result.js";
import { matchResultPanel } from "./match-result.js";
import { ApiClient } from "../api-client.js";
import { ClientFlow, type Screen } from "../flow.js";
import type { MatchState, RoomResult, RoomSnapshot, Tile } from "../protocol.js";
import { button, element } from "./dom.js";
import { actionButtons, runAction } from "./action-buttons.js";
import { readRuntimeConfig } from "./runtime-config.js";
import { roundLabel, roundResultText } from "./result-text.js";
import { nicknameOf, resolveSeat, sortedHand } from "./table-order.js";
import { discardGroups, freshDiscardSeat } from "./tile-view.js";
import { meldBox, tileChip } from "./tile-chips.js";
import { SUIT_LABEL, SUITS, suitOf, tileLabel } from "./tile-label.js";
import { BrowserSocketTransportFactory, FetchHttpTransport, FetchUploadTransport } from "./transports.js";

/**
 * 四家同屏调试客户端（`GET /multi`）。
 *
 * 为什么要它：内测最费事的一步是「凑四个人同时在线」，而大量问题（回合轮转、结算、
 * 碰杠胡的时序、血战后期谁还在轮转里）根本不需要四个真人 —— 只需要四条**真实的客户端连接**。
 * 这个页面在一台设备上开四条独立连接，把四家的手牌与操作都摊在同一个屏幕上，
 * 一个人就能把整局打完。
 *
 * 它复用 `ClientFlow`，与单人版 `/debug`、与最终的 LayaAir 版是**同一套业务层**，
 * 所以在这里打出来的行为就是真机上的行为，不是另写的一套模拟器。
 *
 * 服务端是**按座位脱敏**的：每条连接只拿得到自己的手牌（见 `ws-server` 的 `playerSnapshot`）。
 * 四家各看各的，这里把四份视图拼起来 —— 这既是「上帝视角」，也顺带证明了脱敏是真的：
 * 屏幕上每一张牌都来自对应那家自己的连接，而不是服务端多给了什么。
 */

const runtime = readRuntimeConfig();

const SEAT_COUNT = 4;

/**
 * 座位号 → 屏幕方位。
 *
 * 座位号递增就是出牌顺序（见 `packages/rules` 的 `nextSeat`），所以从下家开始依次是
 * 右 → 上 → 左，视觉上刚好绕桌子转一圈 —— 于是「下一个出牌的人」永远是当前行动者的
 * 顺时针邻位，扫一眼就知道接下来轮到谁。
 */
const SEAT_POSITIONS = ["bottom", "right", "top", "left"] as const;

/** 方位的中文名，用在同一张卡片上标「这一家坐在哪」。 */
const POSITION_LABEL: Record<(typeof SEAT_POSITIONS)[number], string> = {
  bottom: "下",
  right: "右",
  top: "上",
  left: "左",
};

type RoomScreen = Extract<Screen, { name: "room" }>;

interface SeatState {
  /** 这条连接在页面上的固定序号（0..3），**不是**麻将座位号。 */
  readonly slot: number;
  readonly flow: ClientFlow;
  /** 登录后才有：等待期要靠它把服务端分配的座位号对回这条连接。 */
  userId: string | null;
  nickname: string;
  /** 换三张已选中的牌。每家独立，所以不能像单人版那样放模块级变量。 */
  selected: SwapSelection;
  discardSelection: DiscardSelection;
  /** 上一帧的手牌张数，用来认出「这一帧刚摸了一张」。 */
  lastHandSize: number | null;
  /**
   * 刚摸到的那张牌，**只用于显示**，不参与任何判断。
   *
   * 识别办法：这一帧的手牌比上一帧多一张。出牌会让手牌变少、碰与杠也会变少，
   * 所以「多一张」只可能是摸牌。出牌那一刻（手牌变少）自动清空。
   * 刚连上时是 null —— 那一帧没有「上一帧」可比，别猜。
   */
  drawnTile: Tile | null;
}

function makeSeat(slot: number): SeatState {
  const api = new ApiClient(new FetchHttpTransport(runtime.apiBaseUrl));
  const flow = new ClientFlow(api, new BrowserSocketTransportFactory(), runtime.socketUrl, new FetchUploadTransport());
  const seat: SeatState = {
    slot,
    flow,
    userId: null,
    nickname: `玩家 ${slot + 1}`,
    selected: new SwapSelection(),
    discardSelection: new DiscardSelection(),
    lastHandSize: null,
    drawnTile: null,
  };
  flow.onChange((screen) => {
    // 记下「我是谁」：服务端分配的座位号与连接之间没有别的对应关系，
    // 只能靠 userId 反查房间成员列表的下标。
    if (screen.name === "home") {
      seat.userId = screen.me.userId;
      seat.nickname = screen.me.nickname;
    }
    // 离开换三张阶段就清掉选牌。不清的话，靠超时托管过掉换三张（没点按钮）
    // 这一家的选择会留到下一局 —— 那时手里凑巧有同样的牌，就会有一张牌
    // 一进换三张阶段就是选中状态，看着像「我不记得点过它」。
    if (screen.name === "room" && screen.match?.phase !== "swapping" && seat.selected.length > 0) {
      seat.selected.clear();
    }
    // 「刚摸牌」：服务端把摸到的牌 push 在手牌末尾，所以多出来的那张就是它。
    // 只在行牌阶段认 —— 换三张/定缺是发牌，庄家那一手是 14 张，
    // 不限定阶段的话新一局开头会误报一次「刚摸牌」。
    const hand = screen.name === "room" && screen.match?.phase === "playing" ? screen.match.hand : undefined;
    if (hand) {
      if (seat.lastHandSize !== null && hand.length === seat.lastHandSize + 1) {
        seat.drawnTile = hand[hand.length - 1] ?? null;
      } else if (hand.length !== seat.lastHandSize) {
        seat.drawnTile = null;
      }
      seat.lastHandSize = hand.length;
    }
    scheduleRender();
  });
  return seat;
}

/** 四条独立连接。模块加载时就建好，但只有点「自动开局」之后才会真的连上服务端。 */
installTableLayout();

const seats: SeatState[] = Array.from({ length: SEAT_COUNT }, (_, slot) => makeSeat(slot));

// ---------- DOM ----------

const setupPanel = document.querySelector<HTMLElement>("#setup")!;
const boardPanel = document.querySelector<HTMLElement>("#board")!;
const barHost = document.querySelector<HTMLElement>("#bar")!;
const keysHost = document.querySelector<HTMLElement>("#keys")!;
const statusLine = document.querySelector<HTMLElement>("#status")!;
const centerHost = document.querySelector<HTMLElement>("#center")!;

const keyInputs: HTMLInputElement[] = [];
for (let slot = 0; slot < SEAT_COUNT; slot += 1) {
  const input = element("input", { className: "text" });
  input.placeholder = `玩家 ${slot + 1} 的邀请密钥`;
  input.spellcheck = false;
  keyInputs.push(input);
  keysHost.append(element("div", { className: "key-row" },
    element("span", { className: "key-tag", text: `${slot + 1}` }),
    input,
  ));
}

function setStatus(message: string): void {
  statusLine.textContent = message;
}

function resetBar(): void {
  barHost.replaceChildren(element("span", { text: "绵阳血战麻将 · 四家同屏调试客户端" }));
}

resetBar();

// ---------- 从四条连接里读状态 ----------

function roomOf(seat: SeatState): RoomScreen | null {
  const screen = seat.flow.current;
  return screen.name === "room" ? screen : null;
}

/** 任一家的房间快照：四家看到的是同一份成员列表。 */
function anySnapshot(): RoomSnapshot | null {
  for (const seat of seats) {
    const snapshot = roomOf(seat)?.snapshot;
    if (snapshot) return snapshot;
  }
  return null;
}

/** 任一家的对局视图。四家的 `roundNumber` / `tilesLeft` / `currentPlayerSeat` 全一致。 */
function anyMatch(): MatchState | null {
  for (const seat of seats) {
    const match = roomOf(seat)?.match;
    if (match) return match;
  }
  return null;
}

/**
 * 这条连接坐几号位。
 *
 * 三级回退的规则与理由见 `table-order.ts` 的 `resolveSeat` —— 那是纯函数，
 * 单独测过；这里只负责把四条连接各自的状态喂给它。
 */
function seatNumberOf(seat: SeatState): number {
  const room = roomOf(seat);
  return resolveSeat({
    matchSeat: room?.match?.seat ?? null,
    userId: seat.userId,
    players: room?.snapshot?.players ?? anySnapshot()?.players ?? null,
    fallback: seat.slot,
  });
}

// ---------- 渲染 ----------

let renderQueued = false;

/**
 * 合并同一轮里的多次状态变化。
 *
 * 一局里每出一张牌，四条连接会各推一帧（`game` + `actions`），
 * 直接每次重画会在一瞬间画十几遍同一张牌桌。
 */
function scheduleRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderBoard();
  });
}

function renderBoard(): void {
  if (boardPanel.hidden) return;
  for (let seatNo = 0; seatNo < SEAT_COUNT; seatNo += 1) {
    const position = SEAT_POSITIONS[seatNo];
    if (!position) continue;
    const host = document.querySelector<HTMLElement>(`#pos-${position}`);
    if (!host) continue;
    host.replaceChildren();
    const seat = seats.find((each) => seatNumberOf(each) === seatNo);
    host.append(seat ? seatCard(seat, seatNo) : element("p", { className: "hint", text: `${seatNo} 号位 · 空` }));
  }
  renderCenter();
  renderBar();
}

function renderBar(): void {
  const match = anyMatch();
  const snapshot = anySnapshot();
  barHost.replaceChildren(
    element("span", { text: "四家同屏 · 一台设备控制四个玩家" }),
    ...(snapshot ? [element("span", { className: "hint", text: `房间号 ${snapshot.roomNo}` })] : []),
    ...(match ? [element("span", { className: "hint", text: `${roundLabel(match.roundNumber, match.totalRounds)} · ${phaseLabel(match.phase)} · 牌墙剩 ${match.tilesLeft}` })] : []),
    element("span", { className: "spacer" }),
    button("重来", resetAll),
  );
}

function seatCard(seat: SeatState, seatNo: number): HTMLElement {
  const room = roomOf(seat);
  const match = room?.match ?? null;
  const card = element("div", { className: "seat-card" });

  const head = element("div", { className: "seat-head" });
  head.append(
    element("b", { text: `${seatNo} 号位` }),
    element("span", { className: "who", text: seat.nickname }),
  );
  if (match) {
    // 手牌张数是牌桌上最基本的信息（三家各 13 张、轮到谁手上是 14 张）。
    head.append(element("span", { className: "count", text: `手牌 ${match.hand.length} 张` }));
    if (match.phase === "playing" && match.currentPlayerSeat === seatNo) {
      head.append(element("span", { className: "tag acting", text: "待出牌" }));
    }
    if (seat.drawnTile !== null) head.append(element("span", { className: "tag drawn", text: "刚摸牌" }));
    if (match.won) head.append(element("span", { className: "tag won", text: "已胡" }));
    if (match.missingSuit) head.append(element("span", { className: "tag", text: `缺${SUIT_LABEL[match.missingSuit]}` }));
  }
  card.append(head);
  // 头像下面显示**整局累计**净输赢（跨 8 小场累加），不是本小场。
  //
  // 局间要换用结算帧里那份：服务端在一小场结束时只发结算帧、不再发对局帧，
  // 于是客户端手上那帧是这一小场最后一次动作**之前**的 —— 它的 matchDelta 差着最后一个
  // 事件（最后一家胡牌的收分）。结算帧里带的是服务端当场算的权威值。
  const liveTotal = match?.players.find((player) => player.seat === seatNo)?.matchDelta;
  const settledTotal = room?.roundFinished
    ? room.lastResult?.players?.find((entry) => entry.playerId === seat.userId)?.matchDelta
    : undefined;
  card.append(playerProfile({ nickname: seat.nickname, avatarUrl: match?.players.find((player) => player.seat === seatNo)?.avatarUrl ?? "",
    matchDelta: settledTotal ?? liveTotal, dealer: match?.dealerSeat === seatNo, missingSuit: match?.missingSuit ?? null }));

  if (!match) {
    card.append(element("p", { className: "hint", text: room?.snapshot?.status === "waiting" ? "等待开局" : "连接中…" }));
  } else {
    card.append(tilesArea(seat, match));
    card.append(element("p", { className: "hint", text: `已出 ${match.discards.length} 张（见中央弃牌区）` }));
  }

  const operations = opsRow(seat, seatNo);
  if (operations.childElementCount > 0) card.append(operations);

  if (room?.notice) card.append(element("p", { className: "error", text: room.notice }));
  return card;
}

/**
 * 这一家摆出来的牌：手牌，紧挨着副露。
 *
 * 副露以前只报一句「副露 1」，看不出碰了什么、杠了什么 —— 而血战到底里
 * 副露直接决定番型（碰碰胡、门清、金钩钓），光看个数等于没看到。
 */
function tilesArea(seat: SeatState, match: MatchState): HTMLElement {
  const area = element("div", { className: "tiles-area" });
  area.append(handBox(seat, match));
  // 副露的渲染在 tile-chips.ts，与单人版 `/debug` 共用一份（张数写错肉眼看不出来）。
  const melds = meldBox(match.melds);
  melds.setAttribute("aria-label", "碰杠区");
  area.append(melds);
  return area;
}

/**
 * 这一家的手牌。
 *
 * `match.hand` 是**这条连接自己的**手牌 —— 服务端只把它发给本人。
 * 点牌：换三张阶段是选中，行牌阶段先选中抬高，再点同一张才打出。
 */
function handBox(seat: SeatState, match: MatchState): HTMLElement {
  const box = element("div", { className: "hand" });
  if (match.hand.length === 0) {
    box.append(element("span", { className: "hint", text: match.won ? "已胡，退出轮转" : "没有手牌" }));
    return box;
  }
  // 刚摸到的那张单独标出来 —— 真牌桌上它就是插在手里、要打出去的那张。
  // 手牌是排好序的，所以标「同值的任意一张」与标原来那张看不出区别。
  seat.selected.sync(match, roomOf(seat)?.actions ?? [], roomOf(seat)?.notice);
  seat.discardSelection.sync(match, roomOf(seat)?.roundFinished ? [] : roomOf(seat)?.actions ?? [], roomOf(seat)?.notice);
  const drawn = seat.drawnTile;
  let drawnMarked = false;
  for (const [index, tile] of sortedHand(match.hand).entries()) {
    const chosen = match.phase === "swapping" ? seat.selected.has(index) : seat.discardSelection.index === index;
    const isDrawn = !drawnMarked && drawn !== null && tile === drawn;
    if (isDrawn) drawnMarked = true;
    const node = element("button", {
      text: tileLabel(tile),
      className: `tile${chosen ? " chosen" : ""}${isDrawn ? " drawn" : ""}`,
      onClick: () => onTileClick(seat, match, tile, index),
    });
    node.disabled = match.phase === "swapping" ? !seat.selected.enabled : !seat.discardSelection.canSelect(match, tile);
    if (match.missingSuit && suitOf(tile) === match.missingSuit) node.classList.add("missing-suit");
    box.append(node);
  }
  return box;
}

function onTileClick(seat: SeatState, match: MatchState, tile: Tile, index: number): void {
  if (match.phase === "swapping") {
    // 选满三张就替换最早选的那张，避免点第四张时不知所措。
    seat.selected.toggle(index);
    scheduleRender();
    return;
  }
  const discard = seat.discardSelection.click(match, index);
  if (discard !== undefined) seat.flow.discard(discard);
  scheduleRender();
}

/** 这一家现在能做什么。按钮用的是**这条连接自己的** `actions`，不是公共的。 */
function opsRow(seat: SeatState, seatNo: number): HTMLElement {
  const row = element("div", { className: "ops" });
  const room = roomOf(seat);
  if (!room) return row;

  const match = room.match;
  // 还没开局：准备 / 开始。
  //
  // 判据必须包含「没有对局帧」这一条，**不能只看快照状态**：快照只在进房、
  // 准备时刷新过，若某条路径漏了刷新它就会一直停在 "waiting"，
  // 于是整局都停在准备按钮上 —— 而碰/杠/胡/过只在 claiming 阶段下发，
  // 那些按钮就永远没有机会出现（实测就是这么丢的：服务端发了 15 次 peng，页面一个没画）。
  if (!match) {
    if (room.snapshot?.status !== "waiting") return row;
    const ready = room.snapshot.players[seatNo]?.ready ?? false;
    row.append(ready
      ? button("取消准备", () => void seat.flow.setReady(false))
      : button("我准备好了", () => void seat.flow.setReady(true), "primary"));
    if (room.snapshot.ownerId === seat.userId) {
      row.append(button("开始对局（房主）", () => seat.flow.startMatch(), "primary"));
    }
    return row;
  }

  if (room.roundFinished) return row;
  // 换三张交上去之后，服务端就不再给这条连接下发 `swap` 动作了。
  // 若只按「没有动作就不画这一行」处理，交完牌的人会看到一片空白 ——
  // 分不清是在等别人还是在等自己。所以这里补一句状态文字。
  // 它是 `span` 不是 `button`，不违反「只在有操作时显示按钮」。
  if (match.phase === "swapping" && !seat.selected.enabled) {
    row.append(element("span", { className: "hint", text: "已提交换牌，等待其他玩家" }));
    return row;
  }
  if (room.actions.length === 0) return row;
  if (match.phase === "swapping") {
    row.append(
      button(`换这三张（${seat.selected.length}/3）`, () => {
        const hand = sortedHand(match.hand);
        if (!seat.selected.valid(hand)) return;
        const tiles = seat.selected.tiles(hand);
        seat.selected.submit(() => seat.flow.swap(tiles));
        scheduleRender();
      }, "primary"),
      button("自动", () => {
        seat.selected.submit(() => seat.flow.autoSwap());
        scheduleRender();
      }),
    );
  }
  if (match.phase === "missing" && room.actions.includes("choose-missing")) {
    for (const suit of SUITS) {
      row.append(button(SUIT_LABEL[suit], () => seat.flow.chooseMissing(suit)));
    }
    row.append(button("自动", () => seat.flow.autoMissing()));
  }
  // 动作名与按钮的对应收在 action-buttons.ts，两个页面共用一份 ——
  // 之前两处各写一遍，结果三个动作名（暗杠/补杠/自摸）一起写错。
  for (const spec of actionButtons(room.actions, match.phase)) {
    row.append(button(spec.label, () => runAction(seat.flow, spec.kind), spec.primary ? "primary" : ""));
  }
  return row;
}

function renderCenter(): void {
  centerHost.replaceChildren();
  const match = anyMatch();
  const snapshot = anySnapshot();
  const result = seats.map((seat) => roomOf(seat)?.lastResult).find((each) => each) ?? null;
  const matchResult = seats.map((seat) => roomOf(seat)?.lastMatchResult).find((each) => each) ?? null;
  // 局间的可靠信号：**收到了结算帧、还没等到下一小场的第一帧**。
  //
  // 不能用 `match.phase === "finished"`：服务端一小场结束时只发结算帧、不发 `game` 帧，
  // 所以客户端的 `match` 永远停在结束**之前**的状态，那个判据一次都不会成立
  // （表现就是结算浮层压根不渲染，像「结算功能消失了」）。
  const roundOver = match === null || seats.some((seat) => roomOf(seat)?.roundFinished === true);
  // 这一小场那屏数字还该显示吗。
  //
  // 显示到 `roundPopUntil` 为止（服务端给的停留时长，玩法是 3 秒）—— 到点自动收，
  // 不需要玩家按任何东西。没有时限（不停留、或对着不下发时长的旧服务端）就一直显示到
  // 新一局的 `game` 帧把 `roundOver` 清掉。
  //
  // ⚠️ `roundPopUntil` 在 `match-finished` 之后**仍然有值**（flow 有意不清它）：
  // 打满 8 小场时没有下一小场，但最后一小场那屏仍要放满 3 秒，之后才交接给结算记录 ——
  // 它得知道那是什么时候。时限取四条连接里任一非空值（四家收的是同一份结算）。
  const popUntil = seats.map((seat) => roomOf(seat)?.roundPopUntil ?? null).find((each) => each !== null) ?? null;
  const popping = result !== null && roundOver && (popUntil === null || Date.now() < popUntil);
  if (popping && result) {
    // 只在牌桌上弹四个数字，不弹面板、不亮牌、不写牌型（见 `round-result.ts`）。
    // `onExpire` 让到点时重画一次 —— 打满 8 小场那一刻要接着显示整局结算记录，
    // 而服务端在那之后已经不再发任何帧。
    centerHost.append(roundScorePop(result, snapshot, popUntil, scheduleRender));
  } else if (matchResult) {
    // 打满 8 小场：3 秒数字放完才出结算记录（账号积分正是在这一刻改的）。
    // 万一没收到最后一小场的结算帧（例如中途解散），这一条也要能单独出得来。
    centerHost.append(matchResultPanel(matchResult, snapshot, result, scheduleRender));
  }

  if (!match) {
    centerHost.append(
      element("p", { className: "room-no", text: snapshot ? `房间 ${snapshot.roomNo}` : "等待连接…" }),
      element("p", { className: "hint", text: snapshot?.status === "waiting" ? "四家到齐后房主开局" : "四家登录中…" }),
    );
    return;
  }

  const drawnTile = seats.find((each) => seatNumberOf(each) === match.currentPlayerSeat)?.drawnTile ?? null;
  centerHost.append(
    element("div", { className: "banner", text: bannerText(match, snapshot, drawnTile) }),
    element("p", { className: "meta", text:
      `${roundLabel(match.roundNumber, match.totalRounds)} · ${phaseLabel(match.phase)} · 牌墙剩 ${match.tilesLeft} 张` }),
  );

  // 打出去的牌集中在中央 —— 以前它们只是每家卡片里的一串文字，
  // 想看一眼「7万 打过了没有」得在四行文字里找。
  centerHost.append(discardGrid(match, snapshot));
  centerHost.append(tableHub(match, roundOver));

  // 那一屏数字退场（新一局已经开始）之后留一行摘要：这一小场谁赢谁输不该凭空消失。
  // 局间走的是上面的数字分支，所以这里只在**局中**显示。
  // 牌型与四家牌面按要求不在小场这一屏出现（`#center>.hint` 在牌桌布局里本来也是隐藏的）。
  if (result && !roundOver) {
    centerHost.append(element("p", { className: "hint", text: roundResultText(result, snapshot) }));
  }
}

function tableHub(match: MatchState, roundOver: boolean): HTMLElement {
  const container = element("div");
  const hub = element("div", { className: "table-hub" });
  const winds = ["东", "南", "西", "北"];
  winds.forEach((wind, seat) => {
    const connection = seats.find((entry) => seatNumberOf(entry) === seat);
    const canAct = connection ? (roomOf(connection)?.actions.length ?? 0) > 0 : false;
    const acting = !roundOver && (match.phase === "playing" ? match.currentPlayerSeat === seat : canAct);
    hub.append(element("span", { className: `wind ${SEAT_POSITIONS[seat]}${acting ? " active" : ""}`, text: wind }));
  });
  const clock = element("span", { className: "turn-clock", text: "—" });
  if (!roundOver && match.actionDeadlineAt) {
    clock.dataset.deadline = String(match.actionDeadlineAt);
    clock.textContent = String(Math.max(0, Math.ceil((match.actionDeadlineAt - Date.now()) / 1000)));
  }
  clock.setAttribute("aria-label", "当前操作剩余秒数");
  hub.append(clock);
  container.append(hub, element("div", { className: "wall-counter" }, element("span", {text:"余牌"}), element("strong", {text:String(match.tilesLeft)})), element("div", {className:"center-status", text:roundOver ? "本小场结束" : `${roundLabel(match.roundNumber, match.totalRounds)} · ${phaseLabel(match.phase)}`}));
  return container;
}

function updateTurnClock(): void {
  for (const clock of Array.from(document.querySelectorAll<HTMLElement>(".turn-clock[data-deadline]"))) {
    const seconds = Math.max(0, Math.ceil((Number(clock.dataset.deadline) - Date.now()) / 1000));
    clock.textContent = String(seconds);
    clock.classList.toggle("urgent", seconds <= 3);
  }
}
setInterval(updateTurnClock, 200);

/**
 * 中央弃牌区：四家各一格，按座位号排。
 *
 * 牌的顺序就是打出来的先后（不做排序）——这是弃牌堆，不是手牌：
 * 「他先打了 3 万、后面又打了 7 万」和反过来是两条不同的信息。
 */
function discardGrid(match: MatchState, snapshot: RoomSnapshot | null): HTMLElement {
  const grid = element("div", { className: "discard-grid" });
  const freshSeat = freshDiscardSeat(match);

  for (const group of discardGroups(match)) {
    const cell = element("div", { className: `discard-cell ${SEAT_POSITIONS[group.seat]}` });
    const position = SEAT_POSITIONS[group.seat];
    // 手牌张数与弃牌张数一起给：牌桌上判断「他听没听、还剩几张」全靠这两个数。
    const handSize = match.players.find((each) => each.seat === group.seat)?.handSize;
    cell.append(element("div", { className: "discard-head" },
      element("b", { text: `${group.seat} 号位` }),
      ...(position ? [element("span", { text: `（${POSITION_LABEL[position]}）` })] : []),
      element("span", { text: nicknameOf(snapshot, group.seat) }),
      element("span", { className: "count", text: `手牌 ${handSize ?? "?"} 张` }),
      element("span", { className: "count", text: `已出 ${group.tiles.length} 张` }),
    ));

    const tiles = element("div", { className: "discard-tiles" });
    group.tiles.forEach((tile, index) => {
      const chip = tileChip(tile);
      // 刚打出的那一张：claiming 阶段全场都在等它，框出来。
      if (group.seat === freshSeat && index === group.tiles.length - 1) chip.classList.add("fresh");
      tiles.append(chip);
    });
    if (group.tiles.length === 0) tiles.append(element("span", { className: "hint", text: "还没出牌" }));
    cell.append(tiles);
    grid.append(cell);
  }
  return grid;
}

function bannerText(match: MatchState, snapshot: RoomSnapshot | null, drawnTile: Tile | null): string {
  if (match.phase === "finished") return "本局已结束";
  // 换三张与定缺是四个人同时做，没有「轮到谁」这回事。
  if (match.phase === "swapping" || match.phase === "missing") {
    return `${phaseLabel(match.phase)}阶段 · 四家同时进行`;
  }
  const seatNo = match.currentPlayerSeat;
  if (seatNo === null) return "等待服务端推进…";
  const name = snapshot?.players[seatNo]?.nickname;
  const who = name ? `${seatNo} 号位（${name}）` : `${seatNo} 号位`;
  // claiming 阶段 currentPlayerSeat 仍是刚出牌的那个人，但他并不在等自己 ——
  // 这里不能说「轮到他出牌」，要说清大家在等什么。
  if (match.phase === "claiming") return `${who} 刚打出一张，其余人可以考虑碰 / 杠 / 胡`;
  // 摸牌是服务端自动做的，牌桌上唯一的痕迹就是「手里多了一张」——
  // 所以这里直接把它报出来，否则看起来像牌凭空多了一张。
  const drew = drawnTile !== null ? ` · 刚摸到 ${tileLabel(drawnTile)}` : "";
  return `轮到 ${who} 出牌${drew}`;
}

function phaseLabel(phase: MatchState["phase"]): string {
  return { swapping: "换三张", missing: "定缺", playing: "行牌", claiming: "等待别人确认", finished: "本局结束" }[phase];
}

// ---------- 自动开局 ----------

let starting = false;

function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`超时：${label}`));
        return;
      }
      setTimeout(tick, 60);
    };
    tick();
  });
}

/**
 * 一条连接登录。
 *
 * 另外兜住「没激活的密钥」：那种情况下 `enterKey` 会停在资料页，
 * 后面每一步都会落空 —— 这里就地把它激活，四个账号才能真正到齐。
 */
async function loginSeat(seat: SeatState, key: string): Promise<void> {
  if (key.length === 0) throw new Error(`玩家 ${seat.slot + 1} 的密钥还没填`);
  await seat.flow.enterKey(key);
  const screen = seat.flow.current;
  if (screen.name === "profile") {
    await seat.flow.submitProfile(screen.key, `玩家 ${seat.slot + 1}`, "https://example.invalid/avatar.png");
  }
  const after = seat.flow.current;
  if (after.name !== "home") {
    const reason = after.name === "key-entry" ? after.error : undefined;
    throw new Error(`玩家 ${seat.slot + 1} 登录失败：${reason ?? "未知原因"}`);
  }
}

/**
 * 一个人把开局做完。
 *
 * 两条路：
 *   * **四家都还挂在同一间房里** → 直接回去。服务端不允许「已在一间房里再建一间」
 *     （建房会返回 409），而「重来」只关连接、不调 `leaveRoom`，
 *     所以点了重来再点自动开局必然撞上这条路；
 *   * 否则 → 一家建房、三家按房间号加入。
 *
 * 之后再看房间状态：还在等人 → 四家准备 + 房主开局；已经在打 → 什么都不做，
 * 重连的对局帧会自己到。
 *
 * 每一步都 `await` 到位再走下一步 —— 中间任何一步失败，画面会停在出问题的那一步，
 * 而不是四个连接各自走一半、留下一个看不出原因的半开局。
 */
async function autoStart(): Promise<void> {
  if (starting) return;
  starting = true;
  try {
    showBoard();
    setStatus("① 四个账号登录中…");
    await Promise.all(seats.map((seat) => loginSeat(seat, keyInputs[seat.slot]?.value.trim() ?? "")));

    // 登录响应会带上「还有哪一局没打完」，四家都指着同一间就说明不必新建。
    const activeRooms = seats.map((seat) => {
      const screen = seat.flow.current;
      return screen.name === "home" ? screen.activeRoom : null;
    });
    const roomId = activeRooms[0]?.roomId ?? null;
    const allInOneRoom = roomId !== null && activeRooms.every((room) => room?.roomId === roomId);
    const sharedRoomNo = activeRooms.find((room) => room !== null)?.roomNo;

    if (allInOneRoom) {
      setStatus(`② 四家都还在一间房里（${sharedRoomNo ?? "?"}），直接回去接着打…`);
      await Promise.all(seats.map((seat) => seat.flow.rejoinActiveRoom()));
    } else {
      const creator = seats[0];
      if (!creator) throw new Error("没有可用的连接");
      setStatus("② 建一个新房间…");
      await creator.flow.createRoom();
      const roomNo = roomOf(creator)?.roomNo;
      if (!roomNo) throw new Error("建房失败：没有拿到房间号");

      setStatus(`③ 其余三家加入房间 ${roomNo}…`);
      await Promise.all(seats.slice(1).map((seat) => seat.flow.joinRoom(roomNo)));
    }

    const snapshot = anySnapshot();
    if (snapshot?.status === "waiting") {
      setStatus("④ 四家准备…");
      await Promise.all(seats.map((seat) => seat.flow.setReady(true)));

      setStatus("⑤ 房主开局…");
      // 房主不一定是 0 号连接：走「回去」那条路时，房主多半是别人。
      const ownerSeat = seats.find((seat) => seat.userId === snapshot.ownerId) ?? seats[0];
      ownerSeat?.flow.startMatch();
    } else {
      setStatus("④ 已经在一局里了，接着打…");
    }

    await waitFor(() => anyMatch() !== null, 12_000, "等待牌桌出现");
    setStatus("");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  } finally {
    starting = false;
  }
}

function showBoard(): void {
  setupPanel.hidden = true;
  boardPanel.hidden = false;
  scheduleRender();
}

/** 断掉四条连接、回到密钥输入。四个账号仍有效，改完密钥可以再来一次。 */
function resetAll(): void {
  for (const seat of seats) {
    seat.flow.signOut();
    seat.selected.clear();
    seat.userId = null;
    seat.nickname = `玩家 ${seat.slot + 1}`;
    seat.lastHandSize = null;
    seat.drawnTile = null;
  }
  setupPanel.hidden = false;
  boardPanel.hidden = true;
  resetBar();
  setStatus("已重置。改完密钥可以再点「自动开局」。");
}

document.querySelector<HTMLButtonElement>("#auto")?.addEventListener("click", () => void autoStart());
document.querySelector<HTMLButtonElement>("#again")?.addEventListener("click", resetAll);
for (const input of keyInputs) {
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void autoStart();
  });
}
