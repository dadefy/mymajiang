/**
 * 动画表现规范：时长、配色、资源路径与牌桌锚点。
 *
 * 这里是**表现层的单一出处**：所有时长都从这张表取，页面代码里不该再出现裸的
 * `Tween.to(node, {...}, 300)`。要调手感改这一个文件。
 *
 * 时长依据：动画负责反馈、不负责表演 —— 出牌节奏约 1.5 秒一手，
 * 所以除胡牌与结算之外全部压在 350ms 以内，且任何一条都不许挡住下一次操作。
 */

/** 一个矩形区域（牌桌设计坐标，1920×1080）。 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 座位在桌上的朝向（自己在下）。 */
export type SeatSide = "top" | "left" | "right" | "bottom";

/**
 * 动画事件携带的信息。
 *
 * 只放**表现需要**的东西：位置由事件决定，牌值只用于画一张幽灵牌。
 * 任何业务判断都不该依赖它 —— 动画层拿不到、也不该拿到可回写的状态。
 */
export interface AnimationPayload {
  side?: SeatSide;
  /** 涉及的牌值（仅用于画出那张牌）。 */
  tile?: number;
  /** 手牌槽位下标（选牌、出牌的起点）。 */
  handIndex?: number;
  /** 该槽位是不是"刚摸上来那张"——牌桌把它排在最右并另算偏移与上浮。 */
  isDrawn?: boolean;
  /** 牌河格号（出牌的落点）。 */
  riverIndex?: number;
  /** 结算/分数的文案。 */
  text?: string;
  /** 本事件对应的得失分。 */
  delta?: number;
}

import type { AnimationCue } from "./AnimationCoordinator.js";

/**
 * 各事件时长（毫秒），**按事件名索引**：新增一个 cue 而忘了定时长，编译就会红。
 *
 * 数值取推荐区间的中段 —— 区间下限不足以让人察觉，上限会开始拖节奏。
 *
 * 依据：动画负责反馈、不负责表演。出牌节奏约 1.5 秒一手，所以除胡与结算之外
 * 全部压在 350ms 以内，且任何一条都不许挡住下一次操作。
 */
export const DURATION_MS: Record<AnimationCue, number> = {
  /** 选牌上抬：推荐 120~160。 */
  "select-tile": 140,
  /** 摸牌滑入：推荐 180~250。 */
  "draw": 210,
  /** 出牌飞行：推荐 180~260。 */
  "discard": 220,
  /** 最近一手弃牌高亮。 */
  "last-discard": 250,
  /** 操作按钮出现：推荐 150~220。 */
  "action-buttons": 180,
  /** 碰：推荐 200~300。 */
  "peng": 250,
  /** 杠：推荐 220~350，比碰长一档，但只长一档。 */
  "kong": 290,
  /** 过：短到几乎只是一下呼吸，别打断连续操作。 */
  "pass": 160,
  /** 胡：推荐 350~600。全桌最重的一下，但仍然不到一秒。 */
  "hu": 480,
  /** 胡型说明停留。 */
  "win-pattern": 700,
  /** 分数飘字。 */
  "score-float": 620,
  /** 轮到谁的那一下。 */
  "turn-highlight": 320,
  /** 最后三秒桌芯强调。 */
  "countdown-final": 320,
  /** 换三张 / 定缺整排横扫。 */
  "swap": 420,
  "choose-missing": 420,
  /** 小局结算卡片入场：推荐 200~300。 */
  "round-finished": 250,
  /** 大局结算：比小局正式一档，靠层次而不是靠时长。 */
  "match-finished": 420,
  /** 页面切换：推荐 250~400。 */
  "screen-transition": 320,
  /** 托管 / 接管提示淡入淡出。 */
  "trustee-on": 260,
  "trustee-off": 260,
};

/**
 * 当前玩家呼吸环一个来回的周期（规范 1.5~2.5 秒）。
 *
 * 它不是单次动画，所以不进 `DURATION_MS`。
 */
export const ACTIVE_PLAYER_LOOP_MS = 2000;

/** 选牌上抬量（牌桌坐标 px，规范 20~30）。 */
export const SELECT_LIFT = 24;
/** 摸牌滑入的位移：只轻滑，不做夸张飞行。 */
export const DRAW_SLIDE_IN = 46;
/** 出牌落定缩放：起飞时略大、落定回到 1。 */
export const DISCARD_SCALE_UP = 1.08;
/** 呼吸环的呼吸幅度：alpha 与极小的缩放，整个环不许闪。 */
export const RING_BREATH_ALPHA = [0.55, 1] as const;
export const RING_BREATH_SCALE = [1, 1.045] as const;

/**
 * 倒计时配色分档（剩余秒数 → 颜色）。
 *
 * >10 秒正常、10 秒以下金色、5 秒以下朱红。**只换环的颜色**，不做整屏闪烁。
 */
export const COUNTDOWN_TIERS = [
  { atMost: 5, color: "#D96C5F", label: "urgent" },
  { atMost: 10, color: "#C6A15B", label: "warn" },
  { atMost: Number.POSITIVE_INFINITY, color: "#F7F4EA", label: "normal" },
] as const;

/** 剩余秒数 → 该用的颜色；`null`（无截止时间）用正常档。 */
export function countdownColor(seconds: number | null): string {
  if (seconds === null) return COUNTDOWN_TIERS[2].color;
  for (const tier of COUNTDOWN_TIERS) {
    if (seconds <= tier.atMost) return tier.color;
  }
  return COUNTDOWN_TIERS[2].color;
}

/**
 * 冻结资源（来自 `mj-icon-design`，只读复制进来，路径见 `docs/ASSETS.md`）。
 *
 * 放在 `resources/` 下是沿用本工程既有约定 —— 牌面就在 `resources/tiles/`，
 * 不再另起一套 `assets/animation/` 目录。
 */
export const ANIMATION_ASSET = {
  ringActive: "resources/animation/ring_active_player.png",
  ringTrack: "resources/animation/ring_countdown_track.png",
  ringFill: "resources/animation/ring_countdown_fill.png",
  iconTrustee: "resources/animation/icon_trustee.png",
  iconTakeover: "resources/animation/icon_takeover.png",
} as const;

/* --------------------------------------------------------------------------
 * 牌桌锚点
 *
 * 牌桌布局属于 `RoomPage` + `table-layout.ts`（不在本任务的改动范围）。
 * 下面这几个函数**镜像**它们的算法，好处是动画层不需要牌桌配合就能定位；
 * 代价是牌桌改了坐标必须同步这里 —— 所以只镜像几何常量，不复制任何业务判断。
 * ------------------------------------------------------------------------ */

import {
  BACK_SIDE_W, DIAL_SIZE, DISCARD_GAP_X, DISCARD_GAP_Y, DISCARD_H, DISCARD_W,
  HAND_TILE_GAP, HAND_TILE_H, HAND_TILE_W, MELD_H, MELD_MAX_W, SAFE, SEAT_AVATAR, SEAT_W, TABLE_H, Y,
} from "../../ui/table-layout.js";
import { TABLE_WIDTH } from "../../ui/widgets.js";

/** 四家座位信息的左上角，与 `RoomPage` 的 `SEAT_POS` 同一套坐标。 */
const SEAT_POS: Record<"top" | "left" | "right" | "bottom", { x: number; y: number }> = {
  top: { x: TABLE_WIDTH / 2 - SEAT_W / 2, y: Y.topInfo },
  left: { x: SAFE, y: 432 },
  right: { x: TABLE_WIDTH - SAFE - SEAT_W, y: 432 },
  bottom: { x: SAFE, y: Y.selfInfo },
};

/** 手牌行的起点（`handX = SAFE + SEAT_W + 14`）。 */
const HAND_X = SAFE + SEAT_W + 14;

/** 自己牌河的起点：与牌桌同为 9 列 2 行，居中摆在桌芯下方。 */
const RIVER_COLS = 9;
const RIVER_W = RIVER_COLS * (DISCARD_W + DISCARD_GAP_X) - DISCARD_GAP_X;
const RIVER_X = TABLE_WIDTH / 2 - RIVER_W / 2;

/** 头像矩形（呼吸环与倒计时环挂在它外面）。 */
export function avatarRect(side: keyof typeof SEAT_POS): Rect {
  const pos = SEAT_POS[side];
  return { x: pos.x, y: pos.y, w: SEAT_AVATAR, h: SEAT_AVATAR };
}

/** 副露区左上角：碰/杠那三张、四张牌聚拢的落点，与牌桌的 `renderMelds` 同一锚点。 */
export function meldRect(side: "top" | "left" | "right" | "bottom"): Rect {
  const cx = TABLE_WIDTH / 2;
  if (side === "top") return { x: cx - MELD_MAX_W / 2, y: Y.topMelds, w: MELD_MAX_W, h: MELD_H };
  if (side === "bottom") return { x: HAND_X, y: Y.selfMelds, w: MELD_MAX_W, h: MELD_H };
  const x = side === "left"
    ? SAFE + SEAT_W + 12 + BACK_SIDE_W + 14
    : TABLE_WIDTH - SAFE - SEAT_W - 12 - BACK_SIDE_W - 14 - MELD_MAX_W;
  return { x, y: 432, w: MELD_MAX_W, h: MELD_H };
}

/** 底部操作区（碰/杠/胡/过那排按钮）的中心：按钮出现与「过」的提示挂在这里。 */
export function actionRowRect(): Rect {
  return { x: TABLE_WIDTH / 2 - 260, y: Y.hand - 78, w: 520, h: 62 };
}

/**
 * 手牌第 `index` 张的矩形。
 *
 * `isDrawn` 那一张牌桌把它排在最右、额外让开 12px 并上浮 10px，这里跟着让。
 */
export function handTileRect(index: number, isDrawn = false): Rect {
  const x = HAND_X + index * (HAND_TILE_W + HAND_TILE_GAP) + (isDrawn ? 12 : 0);
  return { x, y: Y.hand - (isDrawn ? 10 : 0), w: HAND_TILE_W, h: HAND_TILE_H };
}

/** 自己牌河第 `index` 格（出牌飞行的落点）。 */
export function riverCellRect(index: number): Rect {
  const col = index % RIVER_COLS;
  const row = Math.floor(index / RIVER_COLS);
  return {
    x: RIVER_X + col * (DISCARD_W + DISCARD_GAP_X),
    y: Y.selfRiver + row * (DISCARD_H + DISCARD_GAP_Y),
    w: DISCARD_W,
    h: DISCARD_H,
  };
}

/** 桌芯（中心圆所在的那块正方形）：倒计时环套在这里。 */
export function dialRect(): Rect {
  return { x: TABLE_WIDTH / 2 - DIAL_SIZE / 2, y: Y.dial - DIAL_SIZE / 2, w: DIAL_SIZE, h: DIAL_SIZE };
}

/** 桌面的正中央（结算与胡牌特效的原点）。 */
export function tableCenter(): { x: number; y: number } {
  return { x: TABLE_WIDTH / 2, y: TABLE_H / 2 };
}

/** 环类资源 256×256 源图，贴到目标区域时的边距。 */
export function ringRectFor(target: Rect, padding = 8): Rect {
  const size = Math.max(target.w, target.h) + padding * 2;
  return { x: target.x + target.w / 2 - size / 2, y: target.y + target.h / 2 - size / 2, w: size, h: size };
}
