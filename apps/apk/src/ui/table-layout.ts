import { tableSide, type TableSide } from "./landscape-table.js";

/** 相对座位类型从 landscape-table 转出，调用方不用再多 import 一处。 */
export type { TableSide };

/**
 * 横屏牌桌的版式常量与纯函数。
 *
 * 这一层**不碰任何 Laya 节点** —— 所有坐标、映射、文案拼装都收在这里，
 * 于是能直接单测（`apps/apk/test/table-layout.test.ts`），
 * `RoomPage` 只负责把结果摆到画布上。
 *
 * 版式来自视觉稿 v4，分带如下（1920×1080，左右安全边距 32）：
 *
 *   y   24  顶栏（房号/局数 · 聊天/菜单）
 *   y   88  对家信息
 *   y  162  对家牌背
 *   y  220  对家副露
 *   y  294  对家弃牌 / 上家下家牌背与弃牌
 *   y  440  中央桌芯（正方形，210×210）
 *   y  668  自己弃牌
 *   y  814  自己副露
 *   y  897  自己手牌（100×143，真实资源比例）
 *
 * 由外到内的层次：手牌 → 副露 → 牌河 → 中央桌芯。
 */

/** 设计基准与安全区。2340/2400 多出来的宽度只作两侧留白，牌尺寸不变。 */
export const TABLE_H = 1080;
export const SAFE = 32;

/** 手牌：100×143 是工程真实牌面资源 250×358 的比例（0.699）。 */
export const HAND_TILE_W = 100;
export const HAND_TILE_H = 143;
export const HAND_TILE_GAP = 4;

/** 弃牌 / 副露 / 牌背。都按 250:358 的比例缩，不许拉伸。 */
export const DISCARD_W = 42;
export const DISCARD_H = 60;
export const DISCARD_GAP_X = 4;
export const DISCARD_GAP_Y = 8;
export const MELD_W = 38;
export const MELD_H = 54;
export const BACK_TOP_W = 36;
export const BACK_TOP_H = 40;
export const BACK_TOP_GAP = 3;
export const BACK_SIDE_W = 40;
export const BACK_SIDE_H = 30;
export const BACK_SIDE_GAP = 3;

/** 座位信息（无卡片：头像 + 两行字 + 文字投影）。 */
export const SEAT_AVATAR = 44;
export const SEAT_COL_W = 190;
export const SEAT_W = SEAT_AVATAR + 12 + SEAT_COL_W;

/** 中央桌芯：正方形，内部一条圆（倒计时）＋ 两条对角线切出四个方向区。 */
export const DIAL_SIZE = 210;
export const DIAL_RADIUS = 56;          // 中心圆的半径
export const DIAL_LABEL_BAND = 58;      // 四方向标签所在边的宽度

/** 竖向分带。 */
export const Y = {
  topbar: 24,
  topInfo: 88,
  topBacks: 162,
  topMelds: 220,
  topRiver: 294,
  dial: 440,
  selfRiver: 668,
  selfMelds: 814,
  selfInfo: 866,
  hand: 897,
} as const;
export const SIDE_RIVER_Y = 294;

/** 一副副露最宽是「杠」：4 张牌 + 3 个 2px 缝 + 6px 内边距。 */
export const MELD_MAX_W = MELD_W * 4 + 3 * 2 + 6;

/** 操作按钮的宽度与文案。宽度按优先级递减，视觉权重也就自然分开了。 */
export const ACTION_WIDTH: Record<string, number> = {
  hu: 168, kong: 148, peng: 148, pass: 128, discard: 220,
};
export const ACTION_LABEL: Record<string, string> = {
  hu: "胡", kong: "杠", peng: "碰", pass: "过", discard: "打出",
};
export const ACTION_GAP = 14;

/** 按钮优先级：胡 > 杠 > 碰 > 过。服务端给什么画什么，这个顺序只决定排列次序。 */
const ACTION_ORDER = ["hu", "kong", "peng", "pass"] as const;

/**
 * 桌芯四个方向格与相对座位的对应关系。
 *
 * ⚠️ **这是前端固定展示映射，不是服务端真实 wind 字段。**
 * 协议里没有任何风位字段（只有 `dealerSeat` / `currentPlayerSeat` / `players[].seat`），
 * 所以这一层只是「把底部那一格画成南、右边画成东」的固定牌桌方向，
 * 不代表真实东南西北。要做真实风位，必须先扩服务端协议。
 */
export const WIND_BY_SIDE: Record<TableSide, "N" | "E" | "S" | "W"> = {
  top: "N", right: "E", bottom: "S", left: "W",
};

/** 方向格的绘制顺序（上、右、下、左），与对角线切出的四个三角区一一对应。 */
export const WIND_SLOTS = ["N", "E", "S", "W"] as const;
export type WindSlot = (typeof WIND_SLOTS)[number];

/** 相对座位 → 桌芯方向格。 */
export function windSlotOf(side: TableSide): WindSlot {
  return WIND_BY_SIDE[side];
}

/** 方向格 → 四个三角区的顶点（相对桌芯左上角）。用于 `Graphics.drawPoly`。 */
export function windTriangle(slot: WindSlot, size: number = DIAL_SIZE): number[] {
  const s = size, h = size / 2;
  switch (slot) {
    case "N": return [0, 0, s, 0, h, h];
    case "E": return [s, 0, s, s, h, h];
    case "S": return [s, s, 0, s, h, h];
    case "W": return [0, s, 0, 0, h, h];
  }
}

/** 方向格 → 标签的摆放矩形（贴边、另一轴居中）。 */
export function windLabelBox(slot: WindSlot, size: number = DIAL_SIZE, band: number = DIAL_LABEL_BAND) {
  switch (slot) {
    case "N": return { x: 0, y: 0, w: size, h: band };
    case "S": return { x: 0, y: size - band, w: size, h: band };
    case "W": return { x: 0, y: 0, w: band, h: size };
    case "E": return { x: size - band, y: 0, w: band, h: size };
  }
}

/**
 * 新增的那一张牌。
 *
 * 协议里**没有** `drawnTile` / draw 事件，所以只能从手牌的多重集差推。
 * 但这不是"猜"：只有当新牌恰好多出一张、且没有任何牌消失时，
 * 差额就是唯一确定的那一张；其余情况（张数没变、多了两张、有牌消失
 * —— 例如碰杠换牌）一律返回 null，宁可不提示也不误报。
 */
export function addedTile(prev: readonly number[] | null, next: readonly number[]): number | null {
  if (prev === null || next.length !== prev.length + 1) return null;
  const pool = new Map<number, number>();
  for (const tile of prev) pool.set(tile, (pool.get(tile) ?? 0) + 1);
  let added: number | null = null;
  for (const tile of next) {
    const left = pool.get(tile) ?? 0;
    if (left > 0) {
      pool.set(tile, left - 1);
      continue;
    }
    if (added !== null) return null;   // 多出两张以上 —— 不是单纯摸牌
    added = tile;
  }
  for (const left of pool.values()) if (left !== 0) return null;   // 有牌消失 —— 也不是单纯摸牌
  return added;
}

/** 胡牌摘要（瞬时提示用）。字段全部来自 `RoomResult.wins: WinDetail[]`，客户端不重算番型。 */
export interface HuSummary {
  seat: number;
  /** 「自摸」或「点炮 · 5条」 */
  way: string;
  /** 主要方式 + 主番型 + 至多一个次番型。 */
  fans: string;
  points: number;
  fromSeat: number | null;
}

/**
 * 从服务端的 `WinDetail` 拼瞬时摘要。
 *
 * 番型名直接用 `items[].name`（服务端已经算好中文名），
 * 客户端**不做任何牌型计算**。只取前两个番型，完整的留在小局结算。
 */
export function huSummary(win: {
  seat: number;
  method: "self-draw" | "discard";
  fromSeat: number | null;
  fromTile: number | null;
  items: ReadonlyArray<{ name: string }>;
  points: number;
}, tileName: (tile: number) => string): HuSummary {
  const way = win.method === "self-draw"
    ? "自摸"
    : `点炮${win.fromTile === null ? "" : ` · ${tileName(win.fromTile)}`}`;
  return {
    seat: win.seat,
    way,
    fans: win.items.slice(0, 2).map((item) => item.name).join(" · "),
    points: win.points,
    fromSeat: win.fromSeat,
  };
}

/**
 * 操作区要渲染哪些按钮 —— 严格按服务端 `actions`。
 *
 * `actions` 里没有的种类**根本不出现**（而不是画出来再置灰）。
 * 顺序按 胡 > 杠 > 碰 > 过 排；`discard` 这类行牌动作由调用方另行处理。
 */
export function actionButtons(actions: readonly string[]): string[] {
  return ACTION_ORDER.filter((kind) => actions.indexOf(kind) >= 0);
}

/** 一组按钮的总宽度（含间隙）。用于整体右对齐、并保证数量变化时不留空洞。 */
export function actionsWidth(kinds: readonly string[]): number {
  if (kinds.length === 0) return 0;
  return kinds.reduce((sum, kind) => sum + (ACTION_WIDTH[kind] ?? 148), 0)
    + (kinds.length - 1) * ACTION_GAP;
}

/**
 * 当前操作方所在的方向格；没人操作时返回 null。
 *
 * 服务端 `currentPlayerSeat` 是真实字段，所以「轮到谁」可以精确算出来；
 * 只是把它映射到桌芯的哪一格，用的是上面那条前端固定映射。
 */
export function activeWindSlot(
  mySeat: number,
  currentPlayerSeat: number | null,
): WindSlot | null {
  if (currentPlayerSeat === null) return null;
  return windSlotOf(tableSide(mySeat, currentPlayerSeat));
}

/** 倒计时秒数 → 是否进入"最后三秒"（颜色/字号要明显不同）。 */
export function isFinalCountdown(seconds: number | null): boolean {
  return seconds !== null && seconds >= 0 && seconds <= 3;
}
