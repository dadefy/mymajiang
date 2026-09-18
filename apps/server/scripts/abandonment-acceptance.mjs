/**
 * 端到端验收：四人全部主动退出（migration 012「全员放弃提前终局」）。
 *
 * 与 acceptance.mjs 的差别：那边把 8 局打满验零和；这边专门打 migration 012 的场景 ——
 * **完整打完第 1 小局之后，在第 2 小局中途四人全部点「退出」**，验证：
 *   * 第 2 小局作废：无 winner、不计分（rawDeltas 停留在第 1 局的水平）；
 *   * 大局按已完成的小局收尾：reason=dissolved、completedRounds=1；
 *   * 四家（socket 还连着）都收到 match-finished，且只收到一次；
 *   * 四家 accountDeltas 之和为 0，且等于第 1 局结束时的累计（作废局零进账）；
 *   * 退出后重新登录不再挂「进行中的对局」，房间快照是 dissolved。
 *
 * 用法（仓库根目录）：
 *   node --env-file=apps/server/.env apps/server/scripts/abandonment-acceptance.mjs
 *
 * 前置：服务端在本机 3000 端口跑着（NODE_ENV 任意；内存模式重启会清号，脚本每次自签发）。
 * 覆盖不到（仍需人工 / 浏览器）：结算面板只弹一次、「知道了」能彻底关闭并返回大厅。
 */
import { appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BASE = process.env.SERVER_BASE_URL ?? "http://127.0.0.1:3000";
const WS_URL = process.env.SERVER_WS_URL ?? BASE.replace(/^http/, "ws");
const LEDGER = process.env.KEYS_LEDGER ?? fileURLToPath(new URL("../.keys-ledger-abandon.txt", import.meta.url));

const PLAYERS = ["弃局甲", "弃局乙", "弃局丙", "弃局丁"];

/** 打完第 1 局 + 进入第 2 局的硬上限（正常 1 分钟内）。 */
const SETUP_TIMEOUT_MS = 150_000;
/** 第 4 人退出后等 match-finished 的上限。 */
const FINISH_TIMEOUT_MS = 15_000;

let failures = 0;
const suite = [];
function check(name, ok, detail = "") {
  if (!ok) failures += 1;
  suite.push({ name, ok });
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? `   ${detail}` : ""}`);
}
function section(title) {
  console.log(`\n${title}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(path, { method = "GET", token, body } = {}) {
  const send = async () => {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(token ? { "X-Auth-Token": token } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  };
  const first = await send();
  if (first.status !== 429) return first;
  const wait = Math.min(Number(first.body?.retryAfterSeconds ?? 5), 20);
  console.log(`     （触发限流，等 ${wait} 秒后重试：${method} ${path}）`);
  await sleep(wait * 1_000);
  return send();
}

async function must(path, options) {
  const response = await call(path, options);
  if (response.status >= 300) {
    throw new Error(`${options?.method ?? "GET"} ${path} → HTTP ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body;
}

const WebSocketImpl = globalThis.WebSocket ?? (await import("ws")).WebSocket;

/**
 * 最小可打客户端：只负责「按服务端给的待办自动行牌」，把第 1 局打完。
 * 与 acceptance.mjs 的 AutoPlayer 同一套节奏（game→actions 成对、被拒不重试同牌），
 * 这里砍掉了断线重连等本场景用不到的分支。
 */
class AutoPlayer {
  constructor(nickname) {
    this.nickname = nickname;
    this.game = null;
    this.actions = [];
    this.roundResults = [];
    this.matchResults = [];
    this.errors = [];
    this.pendingActions = false;
    this.retryAfter = 0;
    this.rejectedTiles = new Set();
    this.lastDiscard = null;
    this.inFlightSince = 0;
    this.terminated = false; // 收到 match-finished 后不再响应任何对局帧
  }

  connect(token, roomId) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocketImpl(`${WS_URL}/`);
      this.socket = socket;
      const timer = setTimeout(() => reject(new Error(`${this.nickname}: WebSocket 连接超时`)), 5_000);
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ type: "auth", token, roomId }));
      });
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
        if (message.type === "error" && message.message === "INVALID_USER_TOKEN") {
          clearTimeout(timer);
          reject(new Error(`${this.nickname}: 令牌被拒`));
          return;
        }
        this.absorb(message);
        if (message.type === "room" || message.type === "game" || message.type === "ready") {
          clearTimeout(timer);
          resolve();
        }
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`${this.nickname}: WebSocket 连接失败`));
      });
    });
  }

  absorb(message) {
    if (this.terminated && message.type === "game") return; // 终局后理论上不该再有对局帧
    if (message.type === "game") {
      this.game = message.state;
      this.actions = [];
      this.pendingActions = false;
      this.inFlightSince = 0;
    } else if (message.type === "actions") {
      this.actions = message.actions;
      this.pendingActions = true;
    } else if (message.type === "round-finished") {
      if (!this.terminated) this.roundResults.push(message);
    } else if (message.type === "match-finished") {
      // 不去重是故意的：重复帧本身就是要抓的缺陷（结算面板只弹一次的服务端前提）。
      this.matchResults.push(message.result);
      this.terminated = true;
      this.pendingActions = false;
    } else if (message.type === "error") {
      this.errors.push(message.message);
      if (message.message.includes("Missing suit")) {
        if (this.lastDiscard !== null) this.rejectedTiles.add(this.lastDiscard);
        this.pendingActions = true;
        return;
      }
      this.retryAfter = Date.now() + 800;
    }
  }

  send(payload) {
    this.inFlightSince = Date.now();
    this.socket.send(JSON.stringify(payload));
  }

  quit() {
    this.socket.send(JSON.stringify({ type: "quit" }));
  }

  close() {
    this.socket?.close();
  }

  step() {
    if (!this.pendingActions || this.terminated) return;
    if (this.inFlightSince !== 0 && Date.now() - this.inFlightSince < 2_000) return;
    if (this.retryAfter !== 0) {
      if (Date.now() < this.retryAfter) return;
      this.retryAfter = 0;
    }
    const game = this.game;
    if (!game || game.phase === "finished") {
      this.pendingActions = false;
      return;
    }
    this.pendingActions = false;
    const actions = this.actions;
    if (game.phase === "swapping" && actions.includes("swap")) return this.send({ type: "auto-swap" });
    if (game.phase === "missing" && actions.includes("choose-missing")) return this.send({ type: "auto-missing" });
    if (game.phase === "claiming") {
      if (actions.includes("hu")) return this.send({ type: "claim", action: "hu" });
      if (actions.includes("pass")) return this.send({ type: "claim", action: "pass" });
      return;
    }
    if (game.phase === "playing" && game.currentPlayerSeat === game.seat && actions.includes("discard")) {
      if (actions.includes("hu")) return this.send({ type: "self-draw" });
      const tile = this.chooseDiscard(game);
      if (tile === undefined) return;
      this.lastDiscard = tile;
      return this.send({ type: "discard", tile });
    }
  }

  chooseDiscard(game) {
    const suitOf = (tile) => ["wan", "tong", "tiao"][Math.floor(tile / 9)];
    const missing = game.hand.filter((tile) => suitOf(tile) === game.missingSuit);
    if (missing.length > 0) return missing[0];
    const unused = game.hand.filter((tile) => !this.rejectedTiles.has(tile));
    const pool = unused.length > 0 ? unused : game.hand;
    return [...pool].sort((left, right) => left - right)[0];
  }
}

function stamp(date = new Date()) {
  const pad = (value) => (value < 10 ? `0${value}` : String(value));
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function prepareAccounts(adminToken) {
  const issued = await must("/v1/admin/invitation-keys", {
    method: "POST",
    token: adminToken,
    body: { count: PLAYERS.length, note: "弃局验收脚本" },
  });
  const keys = issued.keys.map((item) => item.key);
  await appendFile(
    LEDGER,
    `${stamp()}  弃局验收脚本签发 ${keys.length} 把\n${keys.join("\n")}\n\n`,
    "utf8",
  );
  const rows = [];
  for (const [index, nickname] of PLAYERS.entries()) {
    const key = keys[index];
    const activated = await must("/v1/auth/activate", {
      method: "POST",
      body: { key, nickname, avatarUrl: "https://example.invalid/avatar.png" },
    });
    await must(`/v1/admin/users/${activated.userId}/points`, {
      method: "POST",
      token: adminToken,
      body: { delta: 2000, reason: "弃局验收发放" },
    });
    rows.push({ nickname, key, userId: activated.userId });
  }
  return rows;
}

async function main() {
  console.log(`弃局验收目标：${BASE}`);

  section("准备：管理员与测试账号");
  const adminId = process.env.ADMIN_ID;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminId || !adminPassword) throw new Error("缺 ADMIN_ID / ADMIN_PASSWORD —— 用 --env-file 启动");
  const adminSession = await must("/v1/admin/session", { method: "POST", body: { adminId, password: adminPassword } });
  const accounts = await prepareAccounts(adminSession.token);
  check(`签发并激活 ${accounts.length} 个测试账号`, accounts.length === PLAYERS.length);

  section("A. 开局并完整打完第 1 小局");
  const sessions = new Map();
  for (const account of accounts) {
    sessions.set(account.nickname, await must("/v1/auth/login", { method: "POST", body: { key: account.key } }));
  }
  const created = await must("/v1/rooms", { method: "POST", token: sessions.get(PLAYERS[0]).token });
  const roomId = created.roomId;
  for (const nickname of PLAYERS.slice(1)) {
    await must("/v1/rooms/join", {
      method: "POST",
      token: sessions.get(nickname).token,
      body: { roomNo: created.roomNo },
    });
  }

  const players = [];
  for (const nickname of PLAYERS) {
    const player = new AutoPlayer(nickname);
    await player.connect(sessions.get(nickname).token, roomId);
    players.push(player);
  }
  for (const nickname of PLAYERS) {
    await must(`/v1/rooms/${roomId}/ready`, {
      method: "POST",
      token: sessions.get(nickname).token,
      body: { ready: true },
    });
  }
  players[0].send({ type: "start" });

  // 打到「第 1 局已有结算帧、第 2 局已开局」为止 —— 退出必须发生在未完成的小局中途。
  const deadline = Date.now() + SETUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    for (const player of players) {
      if (player.retryAfter !== 0 && Date.now() >= player.retryAfter) {
        player.retryAfter = 0;
        player.pendingActions = true;
      }
      player.step();
    }
    const first = players[0];
    const round1Done = first.roundResults.length >= 1;
    const round2Underway = round1Done
      && players.every((player) => player.game?.roundNumber === 2 && player.game.phase !== "finished");
    if (round1Done && round2Underway) break;
    await sleep(20);
  }
  check("第 1 小局正常打完（四家都收到结算帧）", players.every((player) => player.roundResults.length === 1),
    players.map((player) => player.roundResults.length).join("/"));
  check("第 2 小局已经开局（退出发生在未完成的小局中途）",
    players.every((player) => player.game?.roundNumber === 2 && player.game.phase !== "finished"),
    `phase=${players.map((player) => player.game?.phase).join("/")}`);

  // 第 1 局结束时的累计净输赢（按座位对齐）：这就是作废局必须保持住的基线。
  const round1 = players[0].roundResults[0].result;
  const baseline = new Map(round1.players.map((entry) => [entry.seat, entry.matchDelta ?? 0]));
  check("第 1 局结算帧带累计分（matchDelta）", baseline.size === 4, JSON.stringify([...baseline]));

  section("B. 前三人退出 —— 不应触发终局");
  players[0].quit();
  await sleep(300);
  players[1].quit();
  await sleep(300);
  players[2].quit();
  await sleep(1_200);
  check("三人退出后大局仍在进行（没有 match-finished）", players.every((player) => player.matchResults.length === 0));
  check("三人退出后没有再推新的小局结算帧", players.every((player) => player.roundResults.length === 1));

  section("C. 第四人退出 —— 全员放弃当场收尾");
  players[3].quit();
  const finishDeadline = Date.now() + FINISH_TIMEOUT_MS;
  while (Date.now() < finishDeadline && players.some((player) => player.matchResults.length === 0)) {
    await sleep(50);
  }
  check("四家都收到 match-finished", players.every((player) => player.matchResults.length >= 1),
    players.map((player) => player.matchResults.length).join("/"));
  check("每家只收到一次结束帧（结算面板只弹一次的服务端前提）",
    players.every((player) => player.matchResults.length === 1),
    players.map((player) => player.matchResults.length).join("/"));

  const result = players[0].matchResults[0];
  check("终局原因是提前解散（dissolved）", result?.reason === "dissolved", `reason=${result?.reason}`);
  check("已完成小局数停在 1（作废局不计入）", result?.completedRounds === 1, `completedRounds=${result?.completedRounds}`);

  section("D. 作废小局不计分、账户零和");
  const rawBySeat = new Map();
  for (const entry of result?.players ?? []) rawBySeat.set(entry.seat, entry.delta);
  const rawSum = [...rawBySeat.values()].reduce((sum, value) => sum + value, 0);
  check("整场结算四家 delta 之和为 0（零和）", rawSum === 0, JSON.stringify([...rawBySeat]));
  const heldSteady = [...baseline.entries()].every(([seat, delta]) => rawBySeat.get(seat) === delta);
  check("累计分保持第 1 局结束时的值（作废局零进账、无 winner）", heldSteady,
    `第1局=${JSON.stringify([...baseline])} 终局=${JSON.stringify([...rawBySeat])}`);

  const accountDeltas = result?.accountDeltas ?? [];
  const accountSum = accountDeltas.reduce((sum, entry) => sum + entry.delta, 0);
  check("实际入账之和为 0", accountSum === 0, JSON.stringify(accountDeltas));
  const knownIds = new Set(accounts.map((account) => account.userId));
  check("入账只落在本场四家身上（净 0 的不写账）",
    accountDeltas.every((entry) => knownIds.has(entry.playerId)));

  section("E. 收尾状态");
  await sleep(800);
  check("终局后没有再推对局帧（无延迟落盘/托管残留动作）",
    players.every((player) => player.roundResults.length === 1 && player.matchResults.length === 1));
  const realErrors = players.flatMap((player) => player.errors).filter((message) => !message.startsWith("Expected phase"));
  check("没有出现「迟到」以外的错误帧", realErrors.length === 0, realErrors.slice(0, 3).join(" / "));

  let balancesMatch = true;
  for (const account of accounts) {
    const after = await must("/v1/auth/login", { method: "POST", body: { key: account.key } });
    if (after.activeRoom !== null && after.activeRoom !== undefined) balancesMatch = false;
    const expected = 2000 + (accountDeltas.find((entry) => entry.playerId === account.userId)?.delta ?? 0);
    if (after.points !== expected) balancesMatch = false;
  }
  check("退出后重新登录：不再挂「进行中的对局」，余额与入账一致", balancesMatch);

  const snapshot = await must(`/v1/rooms/${roomId}`, { token: sessions.get(PLAYERS[0]).token });
  check("房间快照状态是 dissolved", snapshot.status === "dissolved", `status=${snapshot.status}`);

  for (const player of players) player.close();

  section("人工复核项（脚本覆盖不到，浏览器里看）");
  console.log("  · 结算面板只弹出一次、「知道了」能彻底关闭并返回大厅");

  console.log(`\n${failures === 0 ? "✓ 全部通过" : `✗ ${failures} 项失败`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(`\n✗ 验收脚本异常终止：${error?.stack ?? error}`);
  process.exitCode = 1;
});
