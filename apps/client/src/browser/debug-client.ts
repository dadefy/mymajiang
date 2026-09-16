import { ClientFlow, MAX_VOICE_SECONDS, type Screen } from "../flow.js";
import { ApiClient } from "../api-client.js";
import type { GroupMessageView, MatchState, RoomResult, RoomSnapshot, Suit, Tile } from "../protocol.js";
import { activeRing, nicknameOf, relationLabel, turnOrder } from "./table-order.js";
import { BrowserSocketTransportFactory, FetchHttpTransport, FetchUploadTransport } from "./transports.js";
import { BrowserVoiceRecorder } from "./voice-recorder.js";
import { MediaCache } from "./media-cache.js";

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
const flow = new ClientFlow(api, new BrowserSocketTransportFactory(), runtime.socketUrl, new FetchUploadTransport());

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

/**
 * 图片与语音的本地缓存。
 *
 * 服务端签发的读取地址只有几十秒有效期（私有桶只能靠签名读），而消息画到页面上会一直留着 ——
 * 所以这里第一次加载就抓成本地 blob 地址，之后与签名是否过期无关。
 */
const mediaCache = new MediaCache({
  load: async (sourceUrl) => {
    const response = await fetch(sourceUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.blob();
  },
});

/** 当前页面上那串消息的重画函数；媒体加载完成时只重画它，不动别的。 */
let repaintMessages: (() => void) | undefined;

// 媒体状态一变（下载完成或失败）就重画消息列表。整页重画会清掉正在输入的草稿与滚动位置，
// 所以渲染层登记的是「只重画消息」这件事。
mediaCache.onChange(() => repaintMessages?.());

/** 手动换三张时已选中的牌。 */
let selected: Tile[] = [];

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
  app.replaceChildren();
  // 每次重画都先解绑：渲染层自己再登记（否则会指向已经卸载的那份 DOM）。
  repaintMessages = undefined;
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
    bar.append(
      element("span", { text: `房间号 ${screen.roomNo ?? "读取中…"}` }),
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
  joinInput.placeholder = "6 位房间号（建房的人告诉你）";
  joinInput.maxLength = 6;

  app.append(
    panel("开始打牌",
      // 进行中的对局排在最前：有人退出后重新登录，第一眼就该看到「回去接着打」。
      ...(screen.activeRoom
        ? [
            element("div", { className: "row" },
              element("span", {
                text: `你有一局没打完：房间号 ${screen.activeRoom.roomNo}（${screen.activeRoom.playerCount} 人）`,
              }),
              button("回到对局", () => void flow.rejoinActiveRoom(), "primary"),
            ),
          ]
        : []),
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

/**
 * 一条群消息。
 *
 * 图片与语音的 `content` 是服务端签发的**带时效**读取地址（私有桶只能靠签名读），
 * 所以先过 `mediaCache` 抓成本地地址再渲染 —— 直接用那个地址，过一会儿就变成裂图。
 */
function messageNode(message: GroupMessageView): HTMLElement {
  const row = element("p");
  row.append(element("span", { className: "hint", text: `${message.senderNickname ?? message.senderId}：` }));

  if (message.type === "image") row.append(imagePart(message));
  else if (message.type === "voice") row.append(voicePart(message));
  else row.append(element("span", { text: message.content }));
  return row;
}

function imagePart(message: GroupMessageView): HTMLElement {
  const state = mediaCache.peek(message.messageId) ?? mediaCache.resolve(message.messageId, message.content);
  if (state.status === "ready") {
    const image = element("img", { className: "thumb" });
    image.src = state.url;
    image.alt = "图片";
    image.title = "点开看原图";
    // 本地地址在新标签页里同样有效。
    image.addEventListener("click", () => window.open(state.url, "_blank"));
    return image;
  }
  if (state.status === "loading") return element("span", { className: "hint", text: "（图片加载中…）" });
  return button("图片加载失败，点这里重试", () => {
    mediaCache.resolve(message.messageId, message.content, { retry: true });
  });
}

function voicePart(message: GroupMessageView): HTMLElement {
  const seconds = message.voiceSeconds === undefined ? "" : ` ${message.voiceSeconds} 秒`;
  const state = mediaCache.peek(message.messageId) ?? mediaCache.resolve(message.messageId, message.content);
  if (state.status === "ready") {
    const audio = element("audio", { className: "voice" });
    audio.controls = true;
    audio.src = state.url;
    return element("span", { className: "voice-wrap" },
      element("span", { className: "hint", text: `语音${seconds} ` }),
      audio,
    );
  }
  if (state.status === "loading") return element("span", { className: "hint", text: `（语音${seconds} 加载中…）` });
  return button("语音加载失败，点这里重试", () => {
    mediaCache.resolve(message.messageId, message.content, { retry: true });
  });
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
    let current: GroupMessageView[] = [];
    /**
     * 画一批消息。
     *
     * `scrollToBottom` 只在「刚拉到 / 刚发出」时为真：媒体加载完成引起的那次重画要保住
     * 用户当前的滚动位置，否则正在往上翻历史的人会被拽回底部。
     */
    const paint = (list: GroupMessageView[], scrollToBottom = false): void => {
      const offset = messages.scrollTop;
      messages.replaceChildren();
      for (const message of list) messages.append(messageNode(message));
      messages.scrollTop = scrollToBottom ? messages.scrollHeight : offset;
    };
    const load = async (): Promise<void> => {
      const result = await flow.groupMessages(group.groupId, 30);
      if (!result.ok) {
        messages.replaceChildren(element("p", { className: "error", text: "拉取消息失败" }));
        return;
      }
      current = result.value.messages;
      paint(current, true);
    };
    repaintMessages = () => paint(current);
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || !input.value.trim()) return;
      const content = input.value;
      input.value = "";
      void flow.sendGroupText(group.groupId, content).then(load);
    });

    // 图片直传：签发 → 打到存储的 PUT → 用对象键发消息，三步都在 flow 里。
    // 这里只负责把用户选的文件读成字节。
    const picker = element("input", { className: "text" });
    picker.type = "file";
    picker.accept = "image/*";
    picker.addEventListener("change", () => {
      const chosen = picker.files?.[0];
      if (!chosen) return;
      picker.value = "";
      void (async () => {
        const bytes = new Uint8Array(await chosen.arrayBuffer());
        const sent = await flow.uploadGroupImage(group.groupId, {
          bytes,
          contentType: chosen.type || "image/png",
        });
        if (!sent.ok) {
          messages.append(element("p", { className: "error", text: sent.error }));
          return;
        }
        await load();
      })();
    });

    // 语音：点一下开始录，再点一下停止并发送。录音器是浏览器通用的那一份。
    const recorder = new BrowserVoiceRecorder();
    let recording = false;
    let recordTimer: ReturnType<typeof setInterval> | undefined;
    const voiceButton = button("录音", () => {
      void (async () => {
        if (recording) {
          if (recordTimer) clearInterval(recordTimer);
          recordTimer = undefined;
          recording = false;
          voiceButton.textContent = "录音";
          const recorded = await recorder.stop();
          if (!recorded) return;
          const sent = await flow.uploadGroupVoice(group.groupId, recorded);
          if (!sent.ok) {
            messages.append(element("p", { className: "error", text: sent.error }));
            return;
          }
          await load();
          return;
        }
        try {
          await recorder.start();
        } catch {
          messages.append(element("p", {
            className: "error",
            text: "录不了音：需要允许麦克风权限，且页面要在 HTTPS 或 localhost 下",
          }));
          return;
        }
        recording = true;
        recordTimer = setInterval(() => {
          voiceButton.textContent = `录音 ${recorder.elapsedSeconds()}s`;
          // 到上限就自动停（服务端只收 1–60 秒）。
          if (recorder.elapsedSeconds() >= MAX_VOICE_SECONDS) voiceButton.click();
        }, 500);
      })();
    });

    list.append(element("div", { className: "group" },
      element("div", { className: "row" },
        element("strong", { text: group.name }),
        element("span", { className: "hint", text: `号 ${group.groupNo} · ${group.memberCount} 人` }),
        element("span", { className: "spacer" }),
        button("加载消息", () => void load()),
      ),
      messages,
      element("div", { className: "row" }, input, picker, voiceButton),
    ));
  }
  return panel("群聊", list);
}

function renderMatches(screen: Extract<Screen, { name: "home" }>): HTMLElement {
  const list = element("div", { className: "list" });
  if (screen.matches.length === 0) {
    // 战绩需要数据库：内存模式下查不了，这与「自己没打过」是两回事。
    list.append(element("p", {
      className: "hint",
      text: screen.matchesUnavailable ? "当前运行模式没有战绩记录（服务端未配置数据库）。" : "还没有战绩。",
    }));
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
    // 开局的两个硬条件（四人麻将）：满 4 人、且全部准备。
    // 不满足时**直接禁用按钮并说明原因** —— 否则点下去只会被服务端拒，
    // 看到的是一行不显眼的小字，非常像「点了没反应」。
    const seated = snapshot.players.length;
    const allReady = seated === 4 && snapshot.players.every((player) => player.ready);
    const blockedReason = seated < 4
      ? `还差 ${4 - seated} 个人才能开局`
      : (snapshot.players.some((player) => !player.ready) ? "还有玩家没有准备" : "");

    const startButton = button("开始对局（房主）", () => void flow.startMatch(), "primary");
    if (!allReady) {
      startButton.disabled = true;
      startButton.title = blockedReason;
    }
    controls.append(
      button("我准备好了", () => void flow.setReady(true)),
      button("取消准备", () => void flow.setReady(false)),
      startButton,
      ...(blockedReason ? [element("span", { className: "hint", text: blockedReason })] : []),
    );
  }

  app.append(
    panel(`房间（${snapshot?.status ?? "连接中"}）${snapshot ? ` · 已打 ${snapshot.completedRounds} 局` : ""}`,
      players,
      controls,
      ...(screen.notice ? [element("p", { className: "hint", text: screen.notice })] : []),
    ),
  );

  if (screen.match) app.append(renderTable(screen.match, screen.actions, screen.snapshot));
  if (screen.lastResult) app.append(renderResult(screen.lastResult));
}

/** 顶部那行大字：轮到谁。 */
function turnBanner(match: MatchState, snapshot: RoomSnapshot | null): HTMLElement {
  const seat = match.currentPlayerSeat;

  if (match.phase === "finished") {
    return element("div", { className: "turn other", text: "本局已结束" });
  }
  // 换三张与定缺是四个人同时做，没有「轮到谁」这回事。
  if (match.phase === "swapping" || match.phase === "missing") {
    return element("div", { className: "turn other", text: `${phaseLabel(match.phase)}阶段 · 四人同时进行，不分先后` });
  }
  if (seat === null) {
    return element("div", { className: "turn other", text: "等待服务端推进…" });
  }
  if (seat === match.seat) {
    return element("div", { className: "turn mine", text: "轮到你出牌" });
  }
  // claiming 阶段 currentPlayerSeat 仍然是刚出牌的那个人，但他并不在等自己 ——
  // 这里不能说「轮到他出牌」，要说清大家到底在等什么。
  if (match.phase === "claiming") {
    return element("div", { className: "turn other", text:
      `${seat} 号位（${nicknameOf(snapshot, seat)}）刚打出一张，其余人可以考虑碰 / 杠 / 胡` });
  }
  return element("div", { className: "turn other", text: `轮到 ${seat} 号位（${nicknameOf(snapshot, seat)}）出牌` });
}

/** 出牌顺序一行：从我开始走一圈，标出当前行动者与已胡的人。 */
function orderLine(match: MatchState, snapshot: RoomSnapshot | null): HTMLElement {
  const line = element("p", { className: "order" });
  line.append(element("span", { text: "出牌顺序（座位号递增）：" }));
  turnOrder(match).forEach((seat, index) => {
    if (index > 0) line.append(element("span", { text: " → " }));
    const who = seat === match.seat ? `我（${seat} 号位）` : `${nicknameOf(snapshot, seat)}（${seat} 号位）`;
    line.append(element("b", { text: seat === match.currentPlayerSeat ? `${who} ← 当前` : who }));
  });
  const won = match.players.filter((player) => player.won).map((player) => `${player.seat} 号位`);
  if (won.length > 0) line.append(element("span", { text: `　（已胡，不在轮转：${won.join("、")}）` }));
  return line;
}

function renderTable(match: MatchState, actions: string[], snapshot: RoomSnapshot | null): HTMLElement {
  const box = panel(`第 ${match.roundNumber} 局 · ${phaseLabel(match.phase)} · 我坐 ${match.seat} 号位 · 牌墙剩 ${match.tilesLeft}`);

  // 谁该出牌必须一眼看到，所以先给顶部大字，再给一整圈顺序。
  box.append(turnBanner(match, snapshot), orderLine(match, snapshot));

  // 四家各一行。别的三家只给张数与副露，这是服务端脱敏后能给的。
  // 轮到谁就把那一行框出来 —— 只看顶部大字的话，还得自己把座位号换成方位。
  const ring = activeRing(match);
  for (const player of match.players) {
    const isMe = player.seat === match.seat;
    const relation = isMe ? "我" : (ring.includes(player.seat) ? relationLabel(ring, ring.indexOf(player.seat)) : "已胡");
    const detail = [
      `手牌 ${player.handSize} 张`,
      `副露 ${player.melds.length}`,
      `缺 ${player.missingSuit ? SUIT_LABEL[player.missingSuit] : "未定"}`,
      ...(isMe ? [] : [`已出 ${player.discards.map(tileLabel).join(" ") || "无"}`]),
      ...(player.won ? ["已胡"] : []),
    ].join(" · ");
    box.append(element("div", {
      className: `seat${player.seat === match.currentPlayerSeat ? " acting" : ""}${player.won ? " won" : ""}`,
    },
      element("span", { className: "tag", text: `${relation}·${player.seat} 号位` }),
      element("span", { text: detail }),
    ));
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
