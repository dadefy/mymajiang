import { describe, expect, it } from "vitest";
import { acceptRoomSnapshot, deadlineSeconds, effectiveRoomStatus, opponentBacks, roundPopIsLive, tableSide, type RoundPopInput } from "../src/ui/landscape-table.js";

/** 一小场刚结算完的常态：结算帧到了、对局帧还停在结束之前、服务端给了 3 秒停留。 */
function afterRoundFinished(overrides: Partial<RoundPopInput> = {}): RoundPopInput {
  return {
    hasResult: true,
    hasMatch: true,
    roundFinished: true,
    popUntil: 13_000,
    matchSettled: false,
    now: 10_000,
    ...overrides,
  };
}

describe("landscape table", () => {
  it("rotates all absolute seats around the local player", () => {
    for (let me = 0; me < 4; me += 1) {
      expect([0, 1, 2, 3].map((seat) => tableSide(me, seat))).toEqual(
        ["bottom", "right", "top", "left"].slice(4 - me).concat(["bottom", "right", "top", "left"].slice(0, 4 - me)),
      );
    }
  });

  it("derives the clock exclusively from the server deadline", () => {
    expect(deadlineSeconds(12_001, 10_000)).toBe(3);
    expect(deadlineSeconds(9_000, 10_000)).toBe(0);
    expect(deadlineSeconds(null, 10_000)).toBeNull();
  });

  it("represents opponents with backs and count only", () => {
    expect(opponentBacks(3)).toEqual(["back", "back", "back"]);
    expect(Object.keys({ handSize: 3, backs: opponentBacks(3) })).not.toContain("hand");
  });
});

describe("round pop visibility", () => {
  it("shows during the inter-round pause even though the match frame is still the old one", () => {
    // 这就是那个坑：服务端一小场结束只发结算帧、不发 `game` 帧，所以 `hasMatch` 仍是 true。
    // 用「对局帧为空」当判据的话这里会是 false，结算那屏永远不渲染。
    expect(roundPopIsLive(afterRoundFinished())).toBe(true);
  });

  it("hides once the next round's first frame arrives", () => {
    // 新一小场的 `game` 帧会清掉 `roundFinished`。
    expect(roundPopIsLive(afterRoundFinished({ roundFinished: false }))).toBe(false);
  });

  it("hides when the match frame is gone but no round was ever settled", () => {
    expect(roundPopIsLive(afterRoundFinished({ hasResult: false, hasMatch: false }))).toBe(false);
  });

  it("hides once the pause deadline has passed", () => {
    expect(roundPopIsLive(afterRoundFinished({ now: 13_000 }))).toBe(false);
    expect(roundPopIsLive(afterRoundFinished({ now: 12_999 }))).toBe(true);
  });

  it("keeps showing past the deadline when the server sends no pause at all", () => {
    // 旧服务端不下发停留时长：显示到新一局的 `game` 帧把 `roundFinished` 清掉为止。
    expect(roundPopIsLive(afterRoundFinished({ popUntil: null }))).toBe(true);
  });

  it("still hands off to the match settlement when there is no next frame", () => {
    // 打满 8 小场：不会再有下一小场的 `game` 帧，而服务端若也没给停留时长，
    // 这屏就不能永远占着位置 —— 否则整局结算记录永远出不来。
    expect(roundPopIsLive(afterRoundFinished({ popUntil: null, matchSettled: true }))).toBe(false);
  });

  it("lets the last round's pop finish its pause before the settlement takes over", () => {
    // `match-finished` 到达时停留时长还没走完：最后一小场那屏要放满再交接。
    expect(roundPopIsLive(afterRoundFinished({ matchSettled: true }))).toBe(true);
    expect(roundPopIsLive(afterRoundFinished({ matchSettled: true, now: 13_001 }))).toBe(false);
  });

  it("never shows before any round has been settled", () => {
    expect(roundPopIsLive({ hasResult: false, hasMatch: true, roundFinished: false, popUntil: null, matchSettled: false })).toBe(false);
  });
});

describe("room status text", () => {
  it("reports playing while a match frame is held", () => {
    expect(effectiveRoomStatus("playing", true)).toBe("playing");
    expect(effectiveRoomStatus("waiting", false)).toBe("waiting");
  });

  it("lets a dissolved room win over a stale match frame", () => {
    // 中途解散走 REST、服务端不发任何帧，客户端手上那帧对局帧会一直停在解散前 ——
    // 照它报「对局中」的话玩家会一直等一个永远不来的结算。
    expect(effectiveRoomStatus("dissolved", true)).toBe("dissolved");
    expect(effectiveRoomStatus("finished", true)).toBe("finished");
  });

  it("falls back to the room status when there is no match frame", () => {
    expect(effectiveRoomStatus("dissolved", false)).toBe("dissolved");
    expect(effectiveRoomStatus("waiting", false)).toBe("waiting");
  });

  it("reports nothing to show when there is neither room nor match", () => {
    expect(effectiveRoomStatus(null, false)).toBeNull();
  });

  it("keeps a terminal room status from being overwritten by an older snapshot", () => {
    // `Screen.snapshot` 是进房那一刻取的、牌局中不再刷新，而房间页自己的轮询会拿到最新 ——
    // 不挡一下标题栏就在「已解散」和「对局中」之间来回跳。
    expect(acceptRoomSnapshot("dissolved", "playing")).toBe(false);
    expect(acceptRoomSnapshot("finished", "playing")).toBe(false);
    expect(acceptRoomSnapshot("dissolved", "dissolved")).toBe(true);
    expect(acceptRoomSnapshot("playing", "dissolved")).toBe(true);
    expect(acceptRoomSnapshot("waiting", "playing")).toBe(true);
    expect(acceptRoomSnapshot(null, "playing")).toBe(true);
  });
});
