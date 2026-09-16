/**
 * 一整局的积分口径：**头像记整局、跨小场不清零**；一小场只弹四个数字；
 * 停留时长走完、**自动**交接给**整局结算记录**（账号积分正是在那一刻改的），
 * 记录顶部写「开始时间 / 耗时」，下面四行是「头像 + 昵称 + 10 位 id 号 + 本局积分变化」。
 *
 * 为什么要单开一条：这些缺陷单测全绿也照样漏。
 *   * 头像那两个数的口径（本小场 / 整局累计）都在**服务端下发**的字段里，
 *     客户端把它们接错（例如继续读 `roundDelta`）时数据没错、只是显示错；
 *   * 「弹四个数字 → 到点自动出结算记录」这条顺序完全长在渲染层里：
 *     服务端在打满 8 小场那一刻已经不再发任何帧，少了到点回调就没人重画，
 *     结算记录永远不出现（页面看着像「打完了没结算」）；
 *   * 「小场那屏不展示牌型/牌面」也是渲染层的取舍：帧里照样带着 `wins` 与四家手牌；
 *   * 那四行明细只在**整局结算**这一个时刻有数据（头像与 id 在房间成员上、入账分与余额
 *     要等 `finalize()` 写完账号），拼错了在打的过程中完全看不出来。
 *
 * **离线**：不需要服务端、不需要密钥。页面用真实的 `/multi` HTML，模块用真的 `dist`，
 * 只是把四家的 `screen` 换成构造好的帧 —— 与 `check-two-click.mjs` 同一套做法。
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { multiClientHtml } from '../../apps/server/dist/debug-client.js';
import { ClientFlow } from '../../apps/client/dist/flow.js';

/** 四家按座位号排的名字，用来断言「哪一家的分数对到哪个座位」。 */
const NAMES = ['张三', '李四', '王五', '赵六'];
const USER_IDS = ['1000000001', '1000000002', '1000000003', '1000000004'];
/** 座位号 → 屏幕方位的映射，与 multi-client 的 SEAT_POSITIONS 一致。 */
const POSITIONS = ['bottom', 'right', 'top', 'left'];

const entries = [];
ClientFlow.prototype.onChange = function (listener) {
  entries.push({ flow: this, listener });
  return () => {};
};
// 这四个动作会真的发帧；这条探针只关心渲染，发出去的都丢掉。
for (const name of ['discard', 'swap', 'chooseMissing', 'claim']) {
  ClientFlow.prototype[name] = function () {};
}

const dom = new JSDOM(multiClientHtml({}), { url: 'http://127.0.0.1:3000/multi', pretendToBeVisual: true });
Object.assign(globalThis, {
  document: dom.window.document,
  window: dom.window,
  location: dom.window.location,
  requestAnimationFrame: (cb) => setTimeout(cb, 0),
});
await import('../../apps/client/dist/browser/multi-client.js');
document.querySelector('#board').hidden = false;

const document_ = dom.window.document;
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

/** 一次「四家都收到同一份状态」：渲染层读的是四条连接里任意一条。 */
function push(state) {
  for (const [seat, entry] of entries.entries()) {
    const screen = {
      name: 'room',
      roomId: 'r',
      roomNo: '123456',
      busy: false,
      actions: [],
      // 这一小场那屏数字显示到什么时候；`state` 里没给就是不限时（一直显示到下一小场开局）。
      roundPopUntil: null,
      ...state,
      snapshot: {
        roomId: 'r',
        roomNo: '123456',
        ruleVersion: 'MIANYANG_XZ_1_0',
        status: 'playing',
        ownerId: USER_IDS[0],
        completedRounds: (state.match?.roundNumber ?? 1) - 1,
        result: null,
        players: USER_IDS.map((userId, index) => ({
          userId,
          nickname: NAMES[index],
          points: 1000,
          ready: true,
          connected: true,
          disconnectedAt: null,
          reconnectDeadline: null,
        })),
      },
      match: state.match ? { ...state.match, seat, players: state.match.players } : null,
    };
    entry.flow.screen = screen;
    entry.listener(screen);
  }
}

/** 一行四家：`players` 按座位给齐四个数（`roundDelta` 与 `matchDelta` 分开给）。 */
const seatPlayers = ({ round, total, extra = {} }) => POSITIONS.map((_, seat) => ({
  seat,
  handSize: 13,
  melds: [],
  discards: [],
  missingSuit: null,
  won: false,
  avatarUrl: '',
  roundDelta: round[seat],
  matchDelta: total[seat],
  ...extra,
}));

const textOf = (selector) => document_.querySelector(selector)?.textContent?.trim() ?? null;
/** 头像下面那个数，按座位号取（#pos-bottom 就是 0 号位）。 */
const avatarScores = () => POSITIONS.map((position) => textOf(`#pos-${position} .match-score`));
const centerText = () => document_.querySelector('#center')?.textContent ?? '';
const centerValues = () => [...document_.querySelectorAll('#center .score-value')].map((node) => node.textContent.trim());
const centerNames = () => [...document_.querySelectorAll('#center .score-name')].map((node) => node.textContent.trim());

// ---------- ① 第 3 小场进行中：头像记的是**整局累计**，不是本小场 ----------
//
// 前两小场已经结算：0 号位 +20、1 号位 -20；本小场打到一半又给 0 号位 +4。
// 所以头像上该是「本场 +24 / 本场 -24」，而不是本小场的 +4/-4，更不是归零。
push({
  match: {
    roomId: 'r',
    roundNumber: 3,
    totalRounds: 8,
    phase: 'playing',
    currentPlayerSeat: 0,
    tilesLeft: 40,
    hand: [],
    melds: [],
    missingSuit: null,
    discards: [],
    won: false,
    players: seatPlayers({ round: [4, -4, 0, 0], total: [24, -24, 0, 0] }),
  },
  roundFinished: false,
  lastResult: null,
  lastMatchResult: null,
});
await tick();

assert.deepEqual(avatarScores(), ['本场 +24', '本场 -24', '本场 0', '本场 0'],
  '头像要显示整局累计（本场），跨小场不清零');
assert.equal(document_.querySelectorAll('#board .match-score').length, 4, '四家头像都要有那个数');

// ---------- ② 第 3 小场结束：弹的是**本小场**四家的分数，且不入账 ----------
const round3 = {
  roundNumber: 3,
  totalRounds: 8,
  reason: 'three-winners',
  winnerSeats: [0],
  nextDealerSeat: 1,
  deltas: USER_IDS.map((playerId, seat) => ({ playerId, delta: [24, -8, -8, -8][seat] })),
  players: USER_IDS.map((playerId, seat) => ({
    playerId,
    seat,
    won: seat === 0,
    hand: [],
    melds: [],
    matchDelta: [64, -24, -20, -20][seat],
  })),
  wins: [],
};
push({
  match: {
    roomId: 'r',
    roundNumber: 3,
    totalRounds: 8,
    phase: 'playing',
    currentPlayerSeat: 0,
    tilesLeft: 40,
    hand: [],
    melds: [],
    missingSuit: null,
    discards: [],
    won: false,
    players: seatPlayers({ round: [24, -8, -8, -8], total: [64, -24, -20, -20] }),
  },
  roundFinished: true,
  lastResult: round3,
  roundPopUntil: null,
});
await tick();

// 一小场那一屏：**在牌桌上弹一下四个数字**，不弹面板、不亮牌、不写牌型。
assert.equal(document_.querySelectorAll('#center .round-pop').length, 1, '小场结束要在牌桌上弹一块数字');
assert.equal(textOf('#center .round-pop .round-pop-title'), '第 3/8 小场', '弹出来的那块要说清这是第几小场');
assert.deepEqual(centerValues(), ['+24', '-8', '-8', '-8'], '弹出来的数字是**本小场**的四家变化');
assert.deepEqual(centerNames(), ['0 号位 张三', '1 号位 李四', '2 号位 王五', '3 号位 赵六'],
  '四家的分数要按座位排，不能按 playerId 或到达顺序');
// 「小局结算时都不用展示牌型等」：帧里带着 winLines/牌面，渲染层一个都不该画。
// ⚠️ 判据限定在弹出来的那一块里（`#center .round-pop <selector>`）：
// 牌桌本身的副露也是 `.meld-group`，全局选择器会把牌桌上的正常副露误判成「亮了牌」。
for (const selector of ['.win-summary', '.result-player', '.meld-group', '.score-total', '.score-account']) {
  assert.equal(document_.querySelectorAll(`#center .round-pop ${selector}`).length, 0, `小场这一屏不该出现 ${selector}`);
}
// 连整屏面板都不该有 —— 旧版就是 `.panel` 那个盖住牌桌的大浮层。
assert.equal(document_.querySelectorAll('#center .panel').length, 0, '小场这一屏不该有结算面板');
assert.equal(document_.querySelectorAll('#center .round-pop button').length, 0,
  '这一屏不该有按钮：数字到点自己收，不用玩家按任何东西');
// 它得是**压在牌桌上**的一块，不是盖住整屏的浮层（旧版是 position:fixed + 10vmax 遮罩）。
// 用 CSSOM 属性而不是 style 字符串：jsdom 会把内联样式规范化（`position:absolute` → `position: absolute`），
// 拿原文比会莫名其妙地失败。
const popStyle = document_.querySelector('#center .round-pop').style;
assert.equal(popStyle.position, 'absolute', '这一屏该绝对定位压在牌桌上');
assert.ok(!popStyle.boxShadow.includes('10vmax'), '不该有挡住整屏的遮罩');
// 还没打满，**不能**出整局结算记录。
assert.equal(centerText().includes('本局结算记录'), false, '第 3/8 小场就出结算记录是错的');

// ---------- ③ 打满 8 小场：先弹最后一小场那四个数字，放满停留时长才出整局结算记录 ----------
//
// 最后一小场：0 号位 +6、其余 -2。整局累计 [28, -8, -14, -6]（零和）。
// 账号入账与场上的净胜负**故意不一样**（0 号位被扣了 6 分、2 号位少输 6 分）——
// 那是封顶与「积分不为负」处理过的结果，结算记录必须把两笔都摆出来。
const round8 = {
  roundNumber: 8,
  totalRounds: 8,
  reason: 'wall-exhausted',
  winnerSeats: [],
  nextDealerSeat: 2,
  deltas: USER_IDS.map((playerId, seat) => ({ playerId, delta: [6, -2, -2, -2][seat] })),
  players: USER_IDS.map((playerId, seat) => ({
    playerId,
    seat,
    won: false,
    hand: [],
    melds: [],
    matchDelta: [28, -8, -14, -6][seat],
  })),
  wins: [],
};
/**
 * 整局结算帧。
 *
 * 两个时间戳固定成「开始 → +42 分 18 秒」，好让耗时是**算出来**的而不是写死的：
 * 开始时刻本身随时区变（所以断言只匹配形状），但两个戳的差是确定的 2538000 毫秒。
 *
 * `players` 是服务端按座位拼好的四行明细：昵称/头像/10 位 id 号/本局得失分/入账分/余额。
 * 早先只下发一个顶层 `balances`（只有余额），四行明细是后来补的 —— 已合并成只留 `players`。
 */
const START_AT = 1_758_000_000_000;
const finalResult = {
  roomId: 'r',
  completedRounds: 8,
  reason: 'completed',
  rawDeltas: USER_IDS.map((playerId, seat) => ({ playerId, delta: [28, -8, -14, -6][seat] })),
  accountDeltas: USER_IDS.map((playerId, seat) => ({ playerId, delta: [22, -8, -8, -6][seat] })),
  startedAt: START_AT,
  finishedAt: START_AT + 2_538_000,
  players: USER_IDS.map((playerId, seat) => ({
    playerId,
    nickname: NAMES[seat],
    avatarUrl: `https://example.test/${NAMES[seat]}.png`,
    seat,
    delta: [28, -8, -14, -6][seat],
    accountDelta: [22, -8, -8, -6][seat],
    balance: [1022, 992, 992, 994][seat],
  })),
};
push({
  match: {
    roomId: 'r',
    roundNumber: 8,
    totalRounds: 8,
    phase: 'playing',
    currentPlayerSeat: 0,
    tilesLeft: 0,
    hand: [],
    melds: [],
    missingSuit: null,
    discards: [],
    won: false,
    players: seatPlayers({ round: [6, -2, -2, -2], total: [28, -8, -14, -6] }),
  },
  roundFinished: true,
  lastResult: round8,
  lastMatchResult: finalResult,
  // 停留截止时刻。服务端给的是 3 秒（`interRoundPauseMs`），这里缩到 250 毫秒，
  // 只为让探针把「到点自动交接」这一步也真跑到，不用白等 3 秒。
  roundPopUntil: Date.now() + 250,
});
await tick();

// 最后一小场照样是「弹四个数字」那一屏：不是面板、没有按钮。
assert.equal(textOf('#center .round-pop .round-pop-title'), '第 8/8 小场', '打满时最后一小场那一屏照样要出');
assert.equal(document_.querySelectorAll('#center .panel > button').length, 0, '这一屏不该有按钮');
assert.equal(document_.querySelectorAll('#center .match-player-row').length, 0,
  '数字还没放完，结算记录不该同时压上来');
assert.equal(centerText().includes('本局结算记录'), false, '两屏不该同时出现');

// 停留时长走完 → **自动**交接给整局结算记录，不用玩家按任何东西。
// 打满 8 小场时服务端在那之后已经不再发任何帧，靠的就是这一屏自己的到点回调
// （少了它，结算记录永远不出现 —— 这是这条探针最该守住的一条）。
await new Promise((resolve) => setTimeout(resolve, 400));
await tick();

assert.match(centerText(), /本局结算记录 · 打满 8 小场/, '整局结算记录要在数字放完之后自动出');
assert.equal(document_.querySelectorAll('#center .round-pop').length, 0, '结算记录出来时数字那一屏该退场');

assert.match(centerText(), /本局结算记录 · 打满 8 小场/, '整局结算记录只在打满 8 小场后出');
const finalValues = centerValues();
assert.deepEqual(finalValues, ['+28', '-8', '-14', '-6'], '结算记录的主数字是**整局累计**净输赢');
// 0 号位与 2 号位被处理过（+28→+22、-14→-8），所以那两家要多写一个「入账」；
// 1、3 号位的入账分与场上净胜负一致，就不重复写一遍（免得看着像两笔账）。
assert.deepEqual([...document_.querySelectorAll('#center .score-account')].map((node) => node.textContent.trim()),
  ['入账 +22 · 账号 1022 分', '账号 992 分', '入账 -8 · 账号 992 分', '账号 994 分'],
  '要写出账号入账与入账后的余额；入账分与场上净胜负不同时要标出来');
assert.match(centerText(), /账号积分已在上面这一刻结算入账/, '要说清这一屏就是入账那一刻');

// 顶部那行：开始时间 + 耗时。
// 断成两截是有意的 —— 开始时刻是**本地时间**（随时区变），只断言形状；
// 耗时是两个戳的差，必须**算出来**才对得上（这里是 2538000 毫秒 = 42 分 18 秒）。
const timeText = textOf('#center .match-time') ?? '';
assert.match(timeText, /^开始 \d{4}-\d{2}-\d{2} \d{2}:\d{2}/, '结算记录顶部要有「开始 + 年月日时分」');
assert.ok(timeText.endsWith('耗时 42 分 18 秒'), `耗时要由两个时间戳算出来，实际是「${timeText}」`);

// 四行明细：头像 + 昵称 + 10 位 id 号 + 本局积分变化。
assert.equal(document_.querySelectorAll('#center .match-player-row').length, 4, '整局结算要给四位玩家各列一行');
assert.deepEqual([...document_.querySelectorAll('#center .match-player-name')].map((node) => node.textContent.trim()),
  NAMES, '四行要按座位排，昵称对上人');
assert.deepEqual([...document_.querySelectorAll('#center .match-player-id')].map((node) => node.textContent.trim()),
  USER_IDS.map((userId, seat) => `${seat} 号位 · ID ${userId}`),
  '每行要写出座位号与 10 位 id 号');
assert.deepEqual([...document_.querySelectorAll('#center .match-player-delta')].map((node) => node.textContent.trim()),
  ['+28', '-8', '-14', '-6'], '每行的数字是这一局（整场 8 小场）的积分变化，按座位排');
assert.equal(document_.querySelectorAll('#center .match-player-avatar img').length, 4, '四行都要有头像');
assert.deepEqual([...document_.querySelectorAll('#center .match-player-account')].map((node) => node.textContent.trim()),
  ['入账 +22 · 账号 1022 分', '账号 992 分', '入账 -8 · 账号 992 分', '账号 994 分'],
  '每行要写清实际入账分与入账后的余额');

// ---------- ④ 结束后头像仍然是整局累计（不清零、不回到「本场 —」）----------
assert.deepEqual(avatarScores(), ['本场 +28', '本场 -8', '本场 -14', '本场 -6'],
  '打完之后头像必须还是整局的账，不能清零');

console.log('PASS: 头像记整局累计（跨小场不清零）；一小场结束只在牌桌上弹四个数字（按座位、不弹面板、不亮牌、不写牌型、无按钮），停留时长走完自动交接给整局结算记录（顶部写开始时间与耗时，下面四行是头像 + 昵称 + 10 位 id 号 + 本局积分变化，并含账号入账与余额）');
dom.window.close();
process.exit(0);
