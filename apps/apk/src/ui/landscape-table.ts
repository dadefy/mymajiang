export type TableSide = "bottom" | "right" | "top" | "left";

const SIDES: readonly TableSide[] = ["bottom", "right", "top", "left"];

/** 服务端绝对座位转为“自己永远在底部”的相对桌面位置。 */
export function tableSide(mySeat: number, seat: number): TableSide {
  return SIDES[((seat - mySeat) % 4 + 4) % 4]!;
}

/** 倒计时只显示服务端 deadline 的剩余时间，不产生任何自动操作。 */
export function deadlineSeconds(deadline: number | null | undefined, now = Date.now()): number | null {
  if (deadline === null || deadline === undefined) return null;
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

/** 对手渲染模型故意不接受 hand，避免 UI 调试时泄露手牌。 */
export function opponentBacks(handSize: number): readonly "back"[] {
  return Array.from({ length: Math.max(0, handSize) }, () => "back" as const);
}

/** `roundPopIsLive` 的输入：全是渲染层手上的纯数据，不含任何 Laya 节点。 */
export interface RoundPopInput {
  /** 已经收到过一小场结算（`lastResult` 非空）。 */
  hasResult: boolean;
  /** 手上还有对局帧。**注意服务端一小场结束时不会清它。** */
  hasMatch: boolean;
  /** 收到了 `round-finished`、还没等到下一小场的 `game` 帧。 */
  roundFinished: boolean;
  /** 这一小场那屏显示到几时（本地时刻）；`null` = 服务端没给停留时长。 */
  popUntil: number | null;
  /** 整局结算（`match-finished`）已经到达。 */
  matchSettled: boolean;
  now?: number;
}

/**
 * 一小场那屏数字此刻是否该显示。
 *
 * 局间的可靠信号是「收到了结算帧、还没等到下一小场的第一帧」—— 服务端一小场结束时
 * 只发 `round-finished`、**不发 `game` 帧**（见 ws-server 的 broadcastState），
 * 所以客户端手上的对局帧会停在结束**之前**的状态（playing / claiming）。
 * 拿「对局帧为空」当判据一次都不会成立，表现就是结算那屏压根不渲染。
 *
 * `matchSettled` 那一支是为了兜住「没有下一帧」的情况：打满 8 小场时不会再有
 * 下一小场的 `game` 帧，而服务端若没给停留时长，这屏就会永远占着位置，
 * 整局结算记录永远出不来。
 */
export function roundPopIsLive(input: RoundPopInput): boolean {
  if (!input.hasResult) return false;
  if (input.hasMatch && !input.roundFinished) return false;
  if (input.popUntil === null) return !input.matchSettled;
  return (input.now ?? Date.now()) < input.popUntil;
}

/** 房间状态。与 `RoomSnapshot["status"]` 同义，这里单独列一份免得为了一个字符串联合引入依赖。 */
export type RoomLifecycle = "waiting" | "playing" | "finished" | "dissolved";

/**
 * 标题栏该报哪个房间状态；返回 `null` 表示「连接中」。
 *
 * **房间已经结束/解散时以房间为准**，不能因为手上还留着一帧对局帧就报「对局中」：
 * 中途解散走的是 REST（`/rooms/:id/dissolve` 直接改房间状态，不经过 `broadcastState`），
 * 服务端一个字节都不发，客户端手上那帧对局帧会一直停在解散前的状态 ——
 * 照它写「对局中」就是在骗人，玩家会一直等一个永远不来的结算。
 */
export function effectiveRoomStatus(
  roomStatus: RoomLifecycle | null,
  hasMatch: boolean,
): RoomLifecycle | null {
  if (roomStatus === "finished" || roomStatus === "dissolved") return roomStatus;
  if (hasMatch) return "playing";
  return roomStatus;
}

/**
 * 要不要用这份新来的房间快照覆盖手上那份。
 *
 * 房间状态是**单向**的（waiting → playing → finished/dissolved），所以终态一旦到手
 * 就不该再被更早的快照盖回去。
 *
 * 这条不是空想：`Screen.snapshot` 是**进房那一刻**取的，牌局中 flow 不再刷新它，
 * 而房间页自己的 `poll()` 会拿到最新的 —— 每次收到对局帧都会走一遍 `show()`，
 * 不挡一下的话标题栏就在「已解散」和「对局中」之间来回跳（实测就是这样）。
 */
export function acceptRoomSnapshot(current: RoomLifecycle | null, incoming: RoomLifecycle): boolean {
  if (current === "finished" || current === "dissolved") return incoming === current;
  return true;
}
