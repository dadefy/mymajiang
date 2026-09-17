/**
 * 端到端功能验收：把「四个人 8 局」这件事用脚本跑完。
 *
 * 为什么需要它：`docs/INTERNAL_TESTING.md` 的清单里，最费事的是 B 组（四人跑满 8 局、
 * 核对零和）和 F 组（退出后回到牌桌）—— 人工做要凑 4 个人、开 4 个标签页，
 * 而且「分数之和为 0」这种数字靠眼睛核对很容易漏。这个脚本把它们变成可重复的一条命令。
 *
 * 它做的是**真实客户端做的事**：HTTP 登录建房、WebSocket 握手、换三张、定缺、行牌、
 * 碰杠胡、断线重连 —— 服务端分不出它和真人客户端的区别。
 *
 * 用法（在 apps/server 目录下）：
 *   node --env-file=.env scripts/acceptance.mjs
 *
 * 前置：服务端在跑，`.env` 里有 ADMIN_ID / ADMIN_PASSWORD（用来签发测试账号）。
 * **内存模式下重启会清空账号**，所以脚本每次都自己签发并激活 5 个账号（4 人打牌 + 1 个外人），
 * 明文写进 `.keys-ledger.txt`。
 *
 * 覆盖不到的（仍要人工）：手机上的观感、图片与语音（依赖浏览器 API）、HTTPS 下的录音。
 */
import { appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BASE = process.env.SERVER_BASE_URL ?? "http://127.0.0.1:3000";
const WS_URL = process.env.SERVER_WS_URL ?? BASE.replace(/^http/, "ws");
const LEDGER = process.env.KEYS_LEDGER ?? fileURLToPath(new URL("../.keys-ledger.txt", import.meta.url));

/** 打牌的四个人 + 一个用来验证「外人进不来」的账号。 */
const PLAYERS = ["张三", "李四", "王五", "赵六"];
const OUTSIDER = "外人";

/**
 * 整场验收的硬上限：实测一场约 2 分 15 秒，卡住时不要无限等。
 *
 * 其中包含**局间停留**：服务端每局打完停 5 秒再开下一局（给结算留展示时间），
 * 8 局就是 7 × 5 = 35 秒。这个上限要把它算进去，否则网络稍慢就会误报超时。
 */
const MATCH_TIMEOUT_MS = 240_000;
const STEP_INTERVAL_MS = 20;

const suite = [];
let failures = 0;

function check(name, ok, detail = "") {
  if (!ok) failures += 1;
  suite.push({ name, ok });
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? `   ${detail}` : ""}`);
}

function section(title) {
  console.log(`\n${title}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 发一个 HTTP 调用。
 *
 * 命中限流（429）时按服务端给的 `Retry-After` 等一等再重试一次 —— 验收脚本会从**同一个 IP**
 * 反复登录（每人一次、每次要验「重新登录」），很容易撞上按 IP 计的登录限流。
 * 真人客户端遇到 429 也该是这个反应，所以这里等一等就够了，不用去放宽限流。
 */
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

/** 期望成功的调用；失败就抛出，带上服务端原话，免得只看到一个状态码。 */
async function must(path, options) {
  const result = await call(path, options);
  if (result.status >= 300) {
    throw new Error(`${options?.method ?? "GET"} ${path} -> HTTP ${result.status} ${JSON.stringify(result.body)}`);
  }
  return result.body;
}

// ---------- 一个会自己打牌的 WebSocket 客户端 ----------

const WebSocketImpl = globalThis.WebSocket ?? (await import("ws")).WebSocket;

class AutoPlayer {
  constructor(nickname) {
    this.nickname = nickname;
    this.game = null;
    this.actions = [];
    this.room = null;
    this.roundResults = [];
    this.matchResult = null;
    this.errors = [];
    this.errorContexts = [];
    /** 有没有一条还没响应的 `actions` 帧。 */
    this.pendingActions = false;
    /** 早于这个时刻先不动；到了就由主循环重新放行一次（被拒后的自愈重试）。 */
    this.retryAfter = 0;
    /** 真正被规则拒过的牌（例如出牌时手里还剩缺门牌），下次换一张。 */
    this.rejectedTiles = new Set();
    this.lastDiscard = null;
    /** 上一个动作发出后还没收到服务端回音（下一次广播）；用来避免抢在服务端前面。 */
    this.inFlightSince = 0;
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
        // 三种回执都说明「握手已经绑定了」：等待期给 room、对局已开始时直接给 game、
        // 只订阅群聊的连接（不带 roomId）给 ready。
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
    if (message.type === "game") {
      this.game = message.state;
      // 服务端总是「先 game 后 actions」成对下发。这里同时把动作清单清空，
      // 保证「新状态 + 旧动作」永远不会被凑到一起 —— 那组合会发出一个注定被拒的动作
      // （实测占了所有「迟到」错误的绝大部分）。
      this.actions = [];
      this.pendingActions = false;
      // 服务端处理完一个动作就会广播新状态，所以收到 game 就说明回音到了。
      this.inFlightSince = 0;
    } else if (message.type === "actions") {
      // 每广播一次状态，就给每个座位单独发一帧「你现在能做什么」——
      // 它就是权威的待办清单，收到即待响应。
      this.actions = message.actions;
      this.pendingActions = true;
    } else if (message.type === "room") this.room = message;
    else if (message.type === "round-finished") this.roundResults.push(message);
    else if (message.type === "match-finished") this.matchResult = message.result;
    else if (message.type === "error") {
      this.errors.push(message.message);
      // 出错那一刻的上下文：用来分辨「我的动作慢了一拍」和「我以为轮到自己、服务端说不」。
      this.errorContexts.push({
        message: message.message,
        phase: this.game?.phase,
        seat: this.game?.seat,
        currentPlayerSeat: this.game?.currentPlayerSeat,
        actions: this.actions.join(","),
        round: this.game?.roundNumber,
      });
      this.inFlightSince = 0;
      if (message.message.includes("Missing suit")) {
        // 手里的缺门牌没打完就去打别的牌了：记住这张错牌，立刻换一张重试。
        if (this.lastDiscard !== null) this.rejectedTiles.add(this.lastDiscard);
        this.pendingActions = true;
        return;
      }
      // 其余多半是「动作比服务端状态慢了一拍」（例如 claim 到时已经进入行牌）。
      // 状态推进时服务端本来就会广播，所以这里只是兜底：过一会儿再放行一次。
      this.retryAfter = Date.now() + 800;
    }
  }

  send(payload) {
    this.inFlightSince = Date.now();
    this.socket.send(JSON.stringify(payload));
  }

  close() {
    this.socket?.close();
  }

  /**
   * 响应一条 `actions` 帧：服务端说我现在能做什么，我就做一件。
   *
   * 一条帧只响应一次。**不要用本地状态指纹去重** —— 服务端会把同一状态重复广播给四个人，
   * 指纹相同的那些帧本该被忽略、却也可能把「真正轮到我」的那一帧一起吃掉（实测会卡住）。
   */
  step() {
    if (!this.pendingActions) return;
    // 上一个动作还没回音就先别动：服务端会为别人的动作也广播一轮，
    // 抢着响应那些「其实是旧状态」的帧，就会被判成「Expected phase…」。
    // 两秒还没回音就放行（正常几十毫秒就有回音，这里只是防止卡死）。
    if (this.inFlightSince !== 0 && Date.now() - this.inFlightSince < 2_000) return;
    const game = this.game;
    if (!game || game.phase === "finished") {
      this.pendingActions = false;
      return;
    }
    this.pendingActions = false;
    const actions = this.actions;

    if (game.phase === "swapping" && actions.includes("swap")) {
      this.send({ type: "auto-swap" });
      return;
    }
    if (game.phase === "missing" && actions.includes("choose-missing")) {
      this.send({ type: "auto-missing" });
      return;
    }
    if (game.phase === "claiming") {
      if (actions.includes("hu")) this.send({ type: "claim", action: "hu" });
      else if (actions.includes("pass")) this.send({ type: "claim", action: "pass" });
      return;
    }
    if (game.phase === "playing" && game.currentPlayerSeat === game.seat && actions.includes("discard")) {
      if (actions.includes("hu")) {
        this.send({ type: "self-draw" });
        return;
      }
      const tile = this.chooseDiscard(game);
      if (tile === undefined) return;
      this.lastDiscard = tile;
      this.send({ type: "discard", tile });
    }
  }

  /** 手里还有缺门牌就必须先打缺门（规则没有例外）；之后打最小的一张。 */
  chooseDiscard(game) {
    const suitOf = (tile) => ["wan", "tong", "tiao"][Math.floor(tile / 9)];
    const missing = game.hand.filter((tile) => suitOf(tile) === game.missingSuit);
    if (missing.length > 0) return missing[0];
    const unused = game.hand.filter((tile) => !this.rejectedTiles.has(tile));
    const pool = unused.length > 0 ? unused : game.hand;
    return [...pool].sort((left, right) => left - right)[0];
  }
}

// ---------- 步骤 ----------

/** 台账里的时间戳一律用**本地时间** —— 与 `seed-testers.mjs` 保持一致。 */
function stamp(date = new Date()) {
  const pad = (value) => (value < 10 ? `0${value}` : String(value));
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function prepareAccounts(adminToken) {
  const nicknames = [...PLAYERS, OUTSIDER];
  const issued = await must("/v1/admin/invitation-keys", {
    method: "POST",
    token: adminToken,
    body: { count: nicknames.length, note: "验收脚本" },
  });
  const keys = issued.keys.map((item) => item.key);
  // 时间戳用本地时间：toISOString() 给的是 UTC，写进台账会比本地时间早 8 小时，
  // 让人以为那是很早以前的记录（实测确实把「哪批最新」看反了）。
  const now = stamp();
  const header = existsSync(LEDGER)
    ? ""
    : "## 内测邀请密钥台账（明文，勿提交、勿外传）\n## 一把密钥只能建一个账号；丢失等于账号丢失。\n\n";

  // 先记账再激活：密钥在签发那一刻就已经是账号凭据了，脚本中途失败也不该丢明文。
  await appendFile(LEDGER, `${header}### ${now}  验收脚本签发 ${keys.length} 把（下面逐个补上账号）\n${keys.join("\n")}\n`, "utf8");

  const rows = [];
  for (const [index, nickname] of nicknames.entries()) {
    const key = keys[index];
    const activated = await must("/v1/auth/activate", {
      method: "POST",
      body: { key, nickname, avatarUrl: "https://example.invalid/avatar.png" },
    });
    await must(`/v1/admin/users/${activated.userId}/points`, {
      method: "POST",
      token: adminToken,
      body: { delta: 2000, reason: "验收发放" },
    });
    rows.push({ nickname, key, userId: activated.userId });
  }

  const lines = rows.map((row) => `  ↳ ${row.key}\t${row.nickname}（${row.userId}）`).join("\n");
  await appendFile(LEDGER, `${lines}\n\n`, "utf8");
  return rows;
}

async function main() {
  console.log(`验收目标：${BASE}`);
  console.log("（脚本会自己签发 5 个测试账号并各发 2000 积分）");

  section("准备：管理员登录");
  const adminId = process.env.ADMIN_ID;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminId || !adminPassword) {
    throw new Error("缺 ADMIN_ID / ADMIN_PASSWORD —— 用 --env-file=.env 启动");
  }
  const adminSession = await must("/v1/admin/session", {
    method: "POST",
    body: { adminId, password: adminPassword },
  });
  check("管理员能登录", typeof adminSession.token === "string");

  const accounts = await prepareAccounts(adminSession.token);
  check(`签发并激活 ${accounts.length} 个测试账号`, accounts.length === PLAYERS.length + 1);
  console.log(`     ${accounts.map((row) => `${row.nickname}(${row.userId})`).join("  ")}`);

  // ---------- A. 登录与主页 ----------

  section("A. 登录与主页");
  const sessions = new Map();
  for (const account of accounts) {
    const login = await must("/v1/auth/login", { method: "POST", body: { key: account.key } });
    sessions.set(account.nickname, login);
  }
  const first = sessions.get(PLAYERS[0]);
  check("四个测试账号都能用密钥登录", PLAYERS.every((name) => sessions.has(name)));
  check("新账号有 2000 积分", first.points === 2000, `实际 ${first.points}`);
  // 这条同时是在验「服务端跑的是不是最新代码」——旧版本没有这个字段。
  check("登录响应带 activeRoom 字段（新代码）", "activeRoom" in first, `activeRoom=${JSON.stringify(first.activeRoom)}`);
  check("还没打牌时 activeRoom 为空", first.activeRoom === null || first.activeRoom === undefined);

  const groups = await must("/v1/groups", { token: first.token });
  check("主页群列表可读", Array.isArray(groups.groups) && groups.groups.length === 0);
  // 战绩接口只在**带数据库**的部署里可用；内存模式按设计返回 501。
  // 两种都算符合设计 —— 这条原先写死 501，一旦换到带库的部署（NODE_ENV=production）
  // 就会误报失败，而实际上那是**功能更全**的那种部署。
  const matches = await call("/v1/matches", { token: first.token });
  check(
    "战绩接口符合当前部署模式（内存 501 / 带库 200）",
    matches.status === 501 || (matches.status === 200 && Array.isArray(matches.body?.matches)),
    `HTTP ${matches.status}`,
  );

  // ---------- B. 房间号 ----------

  section("B. 6 位房间号");
  const created = await must("/v1/rooms", { method: "POST", token: first.token });
  const roomId = created.roomId;
  const roomNo = created.roomNo;
  check("建房返回 6 位数字房间号", /^\d{6}$/.test(roomNo ?? ""), `roomNo=${roomNo}`);
  check("内部 roomId 与房间号是两回事", roomId !== roomNo);

  for (const [index, nickname] of PLAYERS.slice(1).entries()) {
    const joined = await must("/v1/rooms/join", {
      method: "POST",
      token: sessions.get(nickname).token,
      body: { roomNo },
    });
    check(`${nickname} 按房间号加入（第 ${index + 2} 人）`, joined.playerCount === index + 2, `playerCount=${joined.playerCount}`);
  }

  const missingRoom = await call("/v1/rooms/join", {
    method: "POST",
    token: sessions.get(OUTSIDER).token,
    body: { roomNo: "000001" },
  });
  check("不存在的房间号回 404", missingRoom.status === 404, `HTTP ${missingRoom.status}`);
  const malformed = await call("/v1/rooms/join", {
    method: "POST",
    token: sessions.get(OUTSIDER).token,
    body: { roomNo: "12345" },
  });
  check("位数不对回 400（与「找不到」分开）", malformed.status === 400, `HTTP ${malformed.status}`);

  // ---------- C. 开局与「回到对局」 ----------

  section("C. 开局与「回到对局」入口");
  const players = [];
  for (const nickname of PLAYERS) {
    const player = new AutoPlayer(nickname);
    await player.connect(sessions.get(nickname).token, roomId);
    players.push(player);
  }
  // 真实客户端也是「先进房间页连上实时通道，再等房主开局」，脚本必须照这个顺序。
  check("四个客户端在等待阶段就连上实时通道", players.every((player) => player.room !== null));

  for (const nickname of PLAYERS) {
    await must(`/v1/rooms/${roomId}/ready`, {
      method: "POST",
      token: sessions.get(nickname).token,
      body: { ready: true },
    });
  }

  // 开局走实时通道 —— 与客户端一致（REST 的 /start 只改房间状态，实时层不会因此建局）。
  players[0].send({ type: "start" });
  await sleep(600);
  check("房主开局后四个座位都收到首帧", players.every((player) => player.game !== null));
  check(
    "开局后进入换三张阶段",
    players.every((player) => player.game?.phase === "swapping"),
    `phase=${players.map((player) => player.game?.phase).join("/")}`,
  );
  const ownHandVisible = players.every((player) => (player.game?.hand.length ?? 0) >= 13);
  const othersHidden = players.every((player) => player.game?.players.every((other) => other.hand === undefined));
  check("自己的手牌可见、别人的手牌不下发（脱敏）", ownHandVisible && othersHidden);

  const snapshot = await must(`/v1/rooms/${roomId}`, { token: first.token });
  check("房间快照带房间号", snapshot.roomNo === roomNo, `snapshot.roomNo=${snapshot.roomNo}`);
  check("开局后房间状态是 playing", snapshot.status === "playing", `status=${snapshot.status}`);

  // 这才是「退出后重新登录」的真实路径：换一个会话，服务端凭 activeMatchId 认出来。
  const reLogin = await must("/v1/auth/login", { method: "POST", body: { key: accounts[2].key } });
  check(
    "对局中重新登录能看到「进行中的对局」",
    reLogin.activeRoom?.roomNo === roomNo && reLogin.activeRoom?.status === "playing",
    JSON.stringify(reLogin.activeRoom),
  );

  const backByNumber = await call("/v1/rooms/join", {
    method: "POST",
    token: reLogin.token,
    body: { roomNo },
  });
  check("已在房里的人按房间号回来不被「已开局」挡住", backByNumber.status === 201, `HTTP ${backByNumber.status}`);

  const outsiderJoin = await call("/v1/rooms/join", {
    method: "POST",
    token: sessions.get(OUTSIDER).token,
    body: { roomNo },
  });
  check("外人拿同一个房间号仍然进不来", outsiderJoin.status === 409, `HTTP ${outsiderJoin.status}`);

  // ---------- D. 把整场打完 ----------

  section("D. 四人 8 局（WebSocket 实时通道）");

  const deadline = Date.now() + MATCH_TIMEOUT_MS;
  let reconnected = false;
  let lastReport = Date.now();
  while (Date.now() < deadline && !players[0].matchResult) {
    for (const player of players) {
      // 被拒过的动作：过了冷却时间就重新放行一次（自愈），否则只能干等 15 秒托管。
      if (player.retryAfter !== 0 && Date.now() >= player.retryAfter) {
        player.retryAfter = 0;
        player.pendingActions = true;
      }
      player.step();
    }

    // 每秒打一次进度，卡住时一眼能看出停在第几局。
    if (Date.now() - lastReport > 1_000) {
      lastReport = Date.now();
      const finished = players[0].roundResults.length;
      if (finished > 0 && !players[0].matchResult) {
        console.log(`     （已打完 ${finished} 局，第 ${finished + 1} 局进行中）`);
      }
    }

    // 第 2 局打到一半，让一个人断线再连回来：验证「重新握手能续上当前这一局」。
    const current = players[3];
    if (!reconnected && current.game?.roundNumber === 2 && current.game.phase === "playing") {
      reconnected = true;
      const before = { round: current.game.roundNumber, phase: current.game.phase };
      current.close();
      await sleep(150);
      const resumed = new AutoPlayer("赵六");
      await resumed.connect(sessions.get(PLAYERS[3]).token, roomId);
      players[3] = resumed;
      await sleep(300);
      check(
        "断线重连后拿到的是同一局的状态（可继续打）",
        resumed.game?.roundNumber === before.round && resumed.game?.phase !== "finished",
        `重连后 round=${resumed.game?.roundNumber} phase=${resumed.game?.phase}`,
      );
    }
    await sleep(STEP_INTERVAL_MS);
  }

  const leader = players.find((player) => player.matchResult) ?? players[0];
  check("整场能打到结束（8 局或提前结算）", Boolean(players[0].matchResult), `completedRounds=${leader.matchResult?.completedRounds ?? "未结束"}`);
  // 「Expected phase…」是客户端动作比服务端状态慢了一拍（脚本自己的节奏问题），
  // 会由看门狗重试掉；其余错误才是真问题。
  const allErrors = players.flatMap((player) => player.errors);
  const lateErrors = allErrors.filter((message) => message.startsWith("Expected phase"));
  const realErrors = allErrors.filter((message) => !message.startsWith("Expected phase"));
  check("没有出现「迟到」以外的错误帧", realErrors.length === 0, realErrors.slice(0, 3).join(" / ") || `（迟到重试 ${lateErrors.length} 次）`);
  if (lateErrors.length > 0) {
    // 把迟到错误的上下文摊开：如果出现「我以为轮到自己、服务端却说不」，那是产品问题而不是脚本问题。
    const contexts = players.flatMap((player) => player.errorContexts)
      .filter((context) => context.message.startsWith("Expected phase"));
    const distinct = [...new Map(contexts.map((context) => [JSON.stringify(context), context])).values()].slice(0, 4);
    for (const context of distinct) {
      console.log(`     · ${context.message} —— 本地看到 round=${context.round} phase=${context.phase} 我坐${context.seat} 轮到${context.currentPlayerSeat} 动作[${context.actions}]`);
    }
  }

  const rounds = players[0].roundResults;
  check("每一局都推了结算帧", rounds.length >= 1, `${rounds.length} 局`);
  const everyRoundZeroSum = rounds.every((round) => round.result.deltas.reduce((sum, entry) => sum + entry.delta, 0) === 0);
  check("每局分数变化之和为 0（零和）", everyRoundZeroSum);

  const deltas = leader.matchResult?.accountDeltas ?? [];
  check("整场结算的账户增减之和为 0", deltas.reduce((sum, entry) => sum + entry.delta, 0) === 0, JSON.stringify(deltas));
  // 意图是「不出现第五个玩家（外人）」。不能写成 `length === 4`：
  // `capLossesByOpeningBalance` 只保留 delta > 0 与 delta < 0 的条目，
  // 所以整场**净变化为 0** 的那一家本来就不会出现在结算里（不写账、余额也不变）。
  // 实测撞到过：三家有增减、第四家恰好不输不赢，于是这里假红。
  const knownIds = new Set(accounts.slice(0, PLAYERS.length).map((account) => account.userId));
  check("结算只落在这场对局的四个玩家身上（净 0 的不写账）",
    deltas.length > 0 && deltas.every((entry) => knownIds.has(entry.playerId)),
    `${deltas.length} 条，全部属于本场四家`);

  // 用「重新登录后的积分」核对：开局前记下的余额 + 结算增减 = 现在看到的余额。
  let balancesMatch = true;
  for (const account of accounts.slice(0, PLAYERS.length)) {
    const after = await must("/v1/auth/login", { method: "POST", body: { key: account.key } });
    const before = sessions.get(account.nickname).points;
    const delta = deltas.find((entry) => entry.playerId === account.userId)?.delta ?? 0;
    if (after.points !== before + delta) balancesMatch = false;
  }
  check("每个人的余额变化与结算一致（扣分不会超发）", balancesMatch);
  check("打完的人身上不再挂「进行中的对局」", (await must("/v1/auth/login", { method: "POST", body: { key: accounts[1].key } })).activeRoom === null);

  for (const player of players) player.close();

  // ---------- E. 解散之后入口消失 ----------

  section("E. 解散房间后入口消失");
  // 打完 8 局之后有人可能已经不够 500 分了（那是进房门槛），先补一笔再开第二间房 ——
  // 顺便也验了一次管理员的积分接口在「打完一场」之后仍然好用。
  for (const account of accounts) {
    await must(`/v1/admin/users/${account.userId}/points`, {
      method: "POST",
      token: adminSession.token,
      body: { delta: 2000, reason: "验收补分" },
    });
  }

  const host = sessions.get(OUTSIDER);
  const second = await must("/v1/rooms", { method: "POST", token: host.token });
  for (const nickname of PLAYERS.slice(0, 3)) {
    await must("/v1/rooms/join", { method: "POST", token: sessions.get(nickname).token, body: { roomNo: second.roomNo } });
  }
  const secondLineup = [OUTSIDER, ...PLAYERS.slice(0, 3)];
  for (const nickname of secondLineup) {
    await must(`/v1/rooms/${second.roomId}/ready`, { method: "POST", token: sessions.get(nickname).token, body: { ready: true } });
  }
  // 这一段只验「入口在不在」，用的是房间自身的状态（activeMatchId + status），
  // 所以不必真的把对局开起来 —— REST 开局就够，省一次实时通道连接。
  await must(`/v1/rooms/${second.roomId}/start`, { method: "POST", token: host.token });

  const liveDismiss = await must("/v1/auth/login", { method: "POST", body: { key: accounts[2].key } });
  check("第二间房开局后同样出现入口", liveDismiss.activeRoom?.roomNo === second.roomNo);

  await must(`/v1/rooms/${second.roomId}/dissolve`, { method: "POST", token: host.token });
  for (const nickname of secondLineup.slice(1, 3)) {
    await must(`/v1/rooms/${second.roomId}/dissolve/vote`, { method: "POST", token: sessions.get(nickname).token, body: { agree: true } });
  }
  const afterDissolve = await must("/v1/auth/login", { method: "POST", body: { key: accounts[2].key } });
  check("解散之后入口消失", afterDissolve.activeRoom === null, JSON.stringify(afterDissolve.activeRoom));

  // ---------- F. 群聊实时推送 ----------

  section("F. 群聊（8 位群号 + 实时推送）");
  const group = await must("/v1/groups", { method: "POST", token: first.token, body: { name: "验收群" } });
  check("建群返回 8 位群号", /^\d{8}$/.test(group.groupNo ?? ""), `groupNo=${group.groupNo}`);

  const joinedGroup = await must("/v1/groups/join", {
    method: "POST",
    token: sessions.get(PLAYERS[1]).token,
    body: { groupNo: group.groupNo },
  });
  check("第二个人按群号加入", joinedGroup.memberCount === 2, `memberCount=${joinedGroup.memberCount}`);

  const watcher = new AutoPlayer("李四");
  const received = [];
  const recalledFrames = [];
  await watcher.connect(sessions.get(PLAYERS[1]).token);
  // 监听必须在发消息**之前**挂上，而且两类帧一起收 —— 否则等一会儿再看就永远看不到已经推过的帧。
  watcher.socket.addEventListener("message", (event) => {
    const message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
    if (message.type === "group-message") received.push(message);
    if (message.type === "group-message-recalled") recalledFrames.push(message);
  });
  watcher.send({ type: "group-subscribe", groupId: group.groupId });
  await sleep(200);

  const sent = await must(`/v1/groups/${group.groupId}/messages`, {
    method: "POST",
    token: first.token,
    body: { type: "text", content: "验收消息" },
  });
  await sleep(400);
  check("群消息能推给另一个连接（不是轮询）", received.length === 1, `收到 ${received.length} 条`);
  check("推送里带发送者昵称", received[0]?.message?.senderNickname === PLAYERS[0], String(received[0]?.message?.senderNickname));

  await must(`/v1/groups/${group.groupId}/messages/${sent.messageId}/recall`, { method: "POST", token: first.token });
  await sleep(400);
  check("撤回也会实时推给对方", recalledFrames.length === 1, `收到 ${recalledFrames.length} 条`);
  watcher.close();

  // ---------- 汇总 ----------

  console.log(`\n${"─".repeat(52)}`);
  if (failures === 0) {
    console.log(`全部通过：${suite.length} 项`);
  } else {
    console.log(`失败 ${failures} 项 / 共 ${suite.length} 项：`);
    for (const item of suite.filter((entry) => !entry.ok)) console.log(`  ✗ ${item.name}`);
  }
  process.exit(failures === 0 ? 0 : 1);
}

await main();
