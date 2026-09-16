import { ApiClient } from "../api-client.js";
import { ClientFlow, type Screen } from "../flow.js";
import type { MatchState, RoomResult, RoomSnapshot, Tile } from "../protocol.js";
import { button, element } from "./dom.js";
import { actionButtons, runAction } from "./action-buttons.js";
import { readRuntimeConfig } from "./runtime-config.js";
import { resolveSeat, sortedHand } from "./table-order.js";
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

type RoomScreen = Extract<Screen, { name: "room" }>;

interface SeatState {
  /** 这条连接在页面上的固定序号（0..3），**不是**麻将座位号。 */
  readonly slot: number;
  readonly flow: ClientFlow;
  /** 登录后才有：等待期要靠它把服务端分配的座位号对回这条连接。 */
  userId: string | null;
  nickname: string;
  /** 换三张已选中的牌。每家独立，所以不能像单人版那样放模块级变量。 */
  selected: Tile[];
}

function makeSeat(slot: number): SeatState {
  const api = new ApiClient(new FetchHttpTransport(runtime.apiBaseUrl));
  const flow = new ClientFlow(api, new BrowserSocketTransportFactory(), runtime.socketUrl, new FetchUploadTransport());
  const seat: SeatState = { slot, flow, userId: null, nickname: `玩家 ${slot + 1}`, selected: [] };
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
      seat.selected = [];
    }
    scheduleRender();
  });
  return seat;
}

/** 四条独立连接。模块加载时就建好，但只有点「自动开局」之后才会真的连上服务端。 */
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
    ...(match ? [element("span", { className: "hint", text: `第 ${match.roundNumber} 局 · ${phaseLabel(match.phase)} · 牌墙剩 ${match.tilesLeft}` })] : []),
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
    if (match.currentPlayerSeat === seatNo) head.append(element("span", { className: "tag acting", text: "当前行动" }));
    if (match.won) head.append(element("span", { className: "tag won", text: "已胡" }));
    if (match.missingSuit) head.append(element("span", { className: "tag", text: `缺${SUIT_LABEL[match.missingSuit]}` }));
  }
  card.append(head);

  if (!match) {
    card.append(element("p", { className: "hint", text: room?.snapshot?.status === "waiting" ? "等待开局" : "连接中…" }));
  } else {
    card.append(handBox(seat, match));
    card.append(element("p", { className: "hint", text:
      `副露 ${meldsText(match.melds)} · 已出 ${match.discards.map(tileLabel).join(" ") || "无"}` }));
  }

  card.append(opsRow(seat, seatNo));

  if (room?.notice) card.append(element("p", { className: "error", text: room.notice }));
  return card;
}

function meldsText(melds: MatchState["melds"]): string {
  if (melds.length === 0) return "无";
  return melds
    .map((meld) => `${meld.concealed ? "暗" : ""}${meld.kind === "kong" ? "杠" : "碰"}${tileLabel(meld.tile)}`)
    .join(" ");
}

/**
 * 这一家的手牌。
 *
 * `match.hand` 是**这条连接自己的**手牌 —— 服务端只把它发给本人。
 * 点牌：换三张阶段是选中，行牌阶段直接打出（与单人版一致，少一次确认点击）。
 */
function handBox(seat: SeatState, match: MatchState): HTMLElement {
  const box = element("div", { className: "hand" });
  if (match.hand.length === 0) {
    box.append(element("span", { className: "hint", text: match.won ? "已胡，退出轮转" : "没有手牌" }));
    return box;
  }
  for (const tile of sortedHand(match.hand)) {
    const chosen = seat.selected.includes(tile);
    const node = element("button", {
      text: tileLabel(tile),
      className: `tile${chosen ? " chosen" : ""}`,
      onClick: () => onTileClick(seat, match, tile),
    });
    if (match.missingSuit && suitOf(tile) === match.missingSuit) node.classList.add("missing-suit");
    box.append(node);
  }
  return box;
}

function onTileClick(seat: SeatState, match: MatchState, tile: Tile): void {
  if (match.phase === "swapping") {
    // 选满三张就替换最早选的那张，避免点第四张时不知所措。
    if (seat.selected.includes(tile)) seat.selected = seat.selected.filter((each) => each !== tile);
    else seat.selected = [...seat.selected, tile].slice(-3);
    scheduleRender();
    return;
  }
  if (match.phase === "playing" || match.phase === "claiming") seat.flow.discard(tile);
}

/** 这一家现在能做什么。按钮用的是**这条连接自己的** `actions`，不是公共的。 */
function opsRow(seat: SeatState, seatNo: number): HTMLElement {
  const row = element("div", { className: "ops" });
  const room = roomOf(seat);
  if (!room) return row;

  if (room.snapshot?.status === "waiting") {
    const ready = room.snapshot.players[seatNo]?.ready ?? false;
    row.append(ready
      ? button("取消准备", () => void seat.flow.setReady(false))
      : button("我准备好了", () => void seat.flow.setReady(true), "primary"));
    if (room.snapshot.ownerId === seat.userId) {
      row.append(button("开始对局（房主）", () => seat.flow.startMatch(), "primary"));
    }
    return row;
  }

  const match = room.match;
  if (!match) return row;

  if (match.phase === "swapping") {
    row.append(
      button(`换这三张（${seat.selected.length}/3）`, () => {
        if (seat.selected.length !== 3) return;
        seat.flow.swap([...seat.selected]);
        seat.selected = [];
        scheduleRender();
      }, "primary"),
      button("自动", () => {
        seat.selected = [];
        seat.flow.autoSwap();
      }),
    );
  }
  if (match.phase === "missing") {
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

  if (!match) {
    centerHost.append(
      element("p", { className: "room-no", text: snapshot ? `房间 ${snapshot.roomNo}` : "等待连接…" }),
      element("p", { className: "hint", text: snapshot?.status === "waiting" ? "四家到齐后房主开局" : "四家登录中…" }),
    );
    return;
  }

  centerHost.append(
    element("div", { className: "banner", text: bannerText(match, snapshot) }),
    element("p", { className: "meta", text:
      `第 ${match.roundNumber} 局 · ${phaseLabel(match.phase)} · 牌墙剩 ${match.tilesLeft} 张` }),
  );

  // 四个人都要做的动作，一次点完 —— 省掉四次点击。
  const ops = element("div", { className: "ops" });
  if (match.phase === "swapping") ops.append(button("四家全部自动换三张", () => autoAll("swap"), "primary"));
  if (match.phase === "missing") ops.append(button("四家全部自动定缺", () => autoAll("missing"), "primary"));
  if (ops.childElementCount > 0) centerHost.append(ops);

  const result = seats.map((seat) => roomOf(seat)?.lastResult).find((each) => each);
  if (result) centerHost.append(element("p", { className: "hint", text: resultText(result, snapshot) }));
}

function bannerText(match: MatchState, snapshot: RoomSnapshot | null): string {
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
  return `轮到 ${who} 出牌`;
}

function resultText(result: RoomResult, snapshot: RoomSnapshot | null): string {
  const deltas = result.deltas.map((delta) => {
    const index = snapshot?.players.findIndex((player) => player.userId === delta.playerId) ?? -1;
    const who = index >= 0 ? `${index} 号位` : delta.playerId.slice(-4);
    return `${who} ${delta.delta >= 0 ? "+" : ""}${delta.delta}`;
  });
  return `上一局（${result.reason}）赢家座位 ${result.winnerSeats.join("、") || "无"}　${deltas.join("　")}`;
}

function autoAll(kind: "swap" | "missing"): void {
  for (const seat of seats) {
    seat.selected = [];
    if (kind === "swap") seat.flow.autoSwap();
    else seat.flow.autoMissing();
  }
  scheduleRender();
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
    seat.selected = [];
    seat.userId = null;
    seat.nickname = `玩家 ${seat.slot + 1}`;
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
