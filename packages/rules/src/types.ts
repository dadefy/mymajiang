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

