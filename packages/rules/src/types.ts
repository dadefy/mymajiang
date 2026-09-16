export type Suit = "wan" | "tong" | "tiao";

export type Tile = number;

export interface DeclaredMeld {
  kind: "pong" | "kong";
  tile: Tile;
  concealed?: boolean;
}

export type WinMethod = "discard" | "self-draw";

export interface WinContext {
  concealedTiles: readonly Tile[];
  declaredMelds: readonly DeclaredMeld[];
  missingSuit: Suit;
  method: WinMethod;
  kongAfterDraw?: boolean;
  kongDiscard?: boolean;
  robKong?: boolean;
  heavenly?: boolean;
  earthly?: boolean;
}

export interface FanItem {
  code: string;
  name: string;
  fan: number;
}

export interface FanResult {
  valid: boolean;
  rawFan: number;
  finalFan: number;
  paymentPerOpponent: number;
  items: FanItem[];
}

export interface ScoreDelta {
  playerId: string;
  delta: number;
}

/**
 * 一位赢家的结算明细 —— 给客户端显示「胡了什么牌型」「谁点的炮」。
 *
 * 以前这些只活在服务端的账本（`events`）里，客户端只拿到一个总数：
 * 玩家看不到自己是清一色还是对对胡，也看不到是谁放炮给的。
 */
export interface WinDetail {
  seat: number;
  method: WinMethod;
  /** 点炮（放炮）者的座位；**自摸时为 null**。 */
  fromSeat: number | null;
  /**
   * 胡的那张牌：点炮与抢杠时是别人打出的那张；**自摸时为 null**
   * —— 自己摸的，不需要指出是哪一张。
   */
  fromTile: Tile | null;
  /** 番型明细，名字已是中文（「对对胡」「清一色」「自摸」「平胡」…）。 */
  items: FanItem[];
  /** 各番相加、**未封顶**的番数。 */
  rawFan: number;
  /** 封顶后的番数（封顶 4 番）。 */
  finalFan: number;
  /** 每家付多少分：自摸三家各付，点炮只有放炮者付。 */
  paymentPerOpponent: number;
  /**
   * 一共几家付了这份分。
   *
   * 自摸时**可能少于三家** —— 血战到底里已胡的人不再付，所以后期常常只剩两家付。
   * 单独给这个数，客户端才不会把「自摸」硬写成「三家各付」。
   */
  payerCount: number;
  /** 实收总分。 */
  points: number;
}

