/**
 * 整局结算的「知道了」按钮：**点了就要彻底关闭，重画不得复现**。
 *
 * 为什么单开一条：这个缺陷单测全绿也照样漏 ——
 *   * 旧版点了「知道了」只摘样式、故意留正文，实测每个玩家的房间里
 *     永久挂着一份整场账单，只有「返回大厅再进房」才清得掉；
 *   * 「清状态还是只摘 DOM」的分界长在渲染层：renderCenter 每次重画都按
 *     lastMatchResult 有值就 append 面板，状态没清、只靠 WeakSet 拦的话，
 *     任何一条路径漏判（例如新加的调用点忘了查 dismissed）面板就会复活；
 *   * dismiss 还必须是**按结果**的：清掉旧结算后，下一场打完的新结算
 *     照样要能正常显示 —— 拦过头也是缺陷。
 *
 * **离线**：不需要服务端、不需要密钥。页面用真的 HTML，模块用真的 dist，
 * 只是把 screen 换成构造好的帧 —— 与 check-two-click.mjs 同一套做法。
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { multiClientHtml } from '../../apps/server/dist/debug-client.js';
import { ClientFlow } from '../../apps/client/dist/flow.js';

const NAMES = ['张三', '李四', '王五', '赵六'];
const USER_IDS = ['1000000001', '1000000002', '1000000003', '1000000004'];

const entries = [];
ClientFlow.prototype.onChange = function (listener) {
  entries.push({ flow: this, listener });
  return () => {};
};

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

/** 一份整局结算（match-finished 帧里的 result 形状，字段与域包一致）。 */
function matchResult(id) {
  return {
    roomId: 'r',
    completedRounds: 8,
    reason: 'completed',
    rawDeltas: [{ playerId: USER_IDS[0], delta: 40 }],
    accountDeltas: [{ playerId: USER_IDS[0], delta: 40 }],
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_002_600_000,
    players: USER_IDS.map((playerId, seat) => ({
      playerId,
      nickname: NAMES[seat],
      avatarUrl: '',
      seat,
      delta: seat === 0 ? 40 : -13,
      accountDelta: seat === 0 ? 40 : -13,
      balance: seat === 0 ? 1040 : 987,
    })),
    ...(id === undefined ? {} : { id }),
  };
}

/** 推一份「整局打完」的房间屏（match 已空、小场那屏已过期）。 */
function push(result) {
  const screen = {
    name: 'room',
    roomId: 'r',
    roomNo: '123456',
    busy: false,
    actions: [],
    lastResult: null,
    lastMatchResult: result,
    roundFinished: true,
    // 停留时长已过：数字那屏收掉，该轮到结算记录（或什么都没有）。
    roundPopUntil: Date.now() - 1_000,
    snapshot: {
      roomId: 'r',
      roomNo: '123456',
      ruleVersion: 'MIANYANG_XZ_1_0',
      status: 'finished',
      ownerId: USER_IDS[0],
      completedRounds: 8,
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
    match: null,
  };
  for (const [seat, entry] of entries.entries()) {
    entry.flow.screen = { ...screen, lastMatchResult: seat === 0 ? result : result };
    entry.listener(entry.flow.screen);
  }
}

const panelTitle = () => document_.querySelector('#center h2')?.textContent?.trim() ?? '';
const panelRows = () => document_.querySelectorAll('#center .match-player-row').length;
const dismissButton = () => [...document_.querySelectorAll('#center button')].find((b) => b.textContent === '知道了');

// ---------- ① 整局结算出现：有标题、有四行明细、有「知道了」 ----------
push(matchResult());
await tick();
assert.match(panelTitle(), /^本局结算记录/, '结算记录没出现');
assert.equal(panelRows(), 4, '应有四行玩家明细');
assert.ok(dismissButton(), '结算记录上没有「知道了」按钮');

// ---------- ② 点「知道了」：面板整个从 DOM 上摘掉 ----------
dismissButton().click();
await tick();
assert.equal(panelRows(), 0, '点「知道了」后结算正文还留在页面上');
assert.ok(!/^本局结算记录/.test(panelTitle()), '点「知道了」后结算标题还在页面上');

// ---------- ③ 重画（同一条 screen 再推一遍）：面板不得复现 ----------
//
// 旧版复现的路径正是这里：状态没清、重画又 append。multi-client 侧靠
// isMatchResultDismissed 拦（debug-client 侧由 flow.dismissMatchResult 清状态，单测守住）。
for (const entry of entries) entry.listener(entry.flow.screen);
await tick();
assert.equal(panelRows(), 0, '重画后结算面板复现了 —— 状态没有真正清掉');

// ---------- ④ dismiss 按「这一份结果」生效：新一场的结算要照常显示 ----------
//
// 拦截必须精确到结果对象：下一场打完是**新的** result，
// 被上一场 dismiss 过这件事不该影响它。
push(matchResult('next-match'));
await tick();
assert.match(panelTitle(), /^本局结算记录/, '新一场的结算记录被上一次 dismiss 误杀了');
assert.equal(panelRows(), 4, '新一场的结算记录应有四行明细');

console.log('结论：知道了 → 面板整个摘掉 → 重画不复现 → 新一场的结算照常显示');
// jsdom 的可视化定时器会吊住事件循环，跑完就收。
process.exit(0);
