import { describe, expect, it } from "vitest";
import {
  ACTION_WIDTH,
  WIND_SLOTS,
  actionButtons,
  actionsWidth,
  activeWindSlot,
  addedTile,
  huSummary,
  isFinalCountdown,
  windLabelBox,
  windSlotOf,
  windTriangle,
} from "../src/ui/table-layout.js";

/* 牌值 0..26：0-8 万 / 9-17 筒 / 18-26 条。 */
const tileName = (t: number): string => `${(t % 9) + 1}${["万", "筒", "条"][Math.floor(t / 9)]}`;

describe("addedTile（新摸牌识别）", () => {
  it("手牌恰好多一张时，返回那一张", () => {
    expect(addedTile([1, 2, 3], [1, 2, 3, 9])).toBe(9);
  });

  it("上一帧为 null（首帧）时不猜", () => {
    expect(addedTile(null, [1, 2, 3])).toBeNull();
  });

  it("张数没变时不猜", () => {
    expect(addedTile([1, 2, 3], [1, 2, 4])).toBeNull();
  });

  it("多出两张以上时不猜（一帧里发生了多件事）", () => {
    expect(addedTile([1, 2], [1, 2, 3, 4])).toBeNull();
  });

  it("有牌消失时不猜（碰/杠换了牌）", () => {
    expect(addedTile([1, 2, 3], [4, 5])).toBeNull();
  });

  it("同花色张数变化也能正确识别", () => {
    expect(addedTile([1, 1, 2], [1, 1, 2, 1])).toBe(1);
  });
});

describe("huSummary（胡牌摘要，不重算番型）", () => {
  it("自摸：方式为「自摸」，取前两个番型", () => {
    const s = huSummary(
      { seat: 1, method: "self-draw", fromSeat: null, fromTile: null,
        items: [{ name: "清一色" }, { name: "七对" }, { name: "自摸" }], points: 16 },
      tileName,
    );
    expect(s.way).toBe("自摸");
    expect(s.fans).toBe("清一色 · 七对");
    expect(s.points).toBe(16);
  });

  it("点炮：方式带点炮的牌", () => {
    const s = huSummary(
      { seat: 2, method: "discard", fromSeat: 3, fromTile: 20, items: [{ name: "对对胡" }], points: 8 },
      tileName,
    );
    expect(s.way).toBe("点炮 · 3条");
    expect(s.fans).toBe("对对胡");
  });
});

describe("actionButtons（严格按 actions，不置灰）", () => {
  it("只保留服务端给的那几个，并按 胡>杠>碰>过 排序", () => {
    expect(actionButtons(["pass", "peng", "hu", "kong"])).toEqual(["hu", "kong", "peng", "pass"]);
  });

  it("没有就不出现", () => {
    expect(actionButtons([])).toEqual([]);
    expect(actionButtons(["pass"])).toEqual(["pass"]);
    expect(actionButtons(["peng", "pass"])).toEqual(["peng", "pass"]);
  });

  it("宽度只算出现的那些", () => {
    const four = ACTION_WIDTH.hu + ACTION_WIDTH.kong + ACTION_WIDTH.peng + ACTION_WIDTH.pass + 3 * 14;
    expect(actionsWidth(["hu", "kong", "peng", "pass"])).toBe(four);
    expect(actionsWidth(["pass"])).toBe(ACTION_WIDTH.pass);
    expect(actionsWidth([])).toBe(0);
  });
});

describe("桌芯方向映射（前端固定展示，非服务端风位）", () => {
  it("自己永远在底部=南，下家右=东，对家上=北，上家左=西", () => {
    expect(windSlotOf("bottom")).toBe("S");
    expect(windSlotOf("right")).toBe("E");
    expect(windSlotOf("top")).toBe("N");
    expect(windSlotOf("left")).toBe("W");
  });

  it("当前操作方映射到正确方向；无人操作时为空", () => {
    expect(activeWindSlot(0, 0)).toBe("S");  // 自己
    expect(activeWindSlot(0, 1)).toBe("E");  // 下家
    expect(activeWindSlot(0, 2)).toBe("N");  // 对家
    expect(activeWindSlot(0, 3)).toBe("W");  // 上家
    expect(activeWindSlot(0, null)).toBeNull();
  });

  it("四个方向区是四个三角形，且几何上对称", () => {
    const size = 210;
    const h = size / 2;
    expect(windTriangle("N", size)).toEqual([0, 0, size, 0, h, h]);
    expect(windTriangle("E", size)).toEqual([size, 0, size, size, h, h]);
    expect(windTriangle("S", size)).toEqual([size, size, 0, size, h, h]);
    expect(windTriangle("W", size)).toEqual([0, size, 0, 0, h, h]);
  });

  it("四个方向标签：上下贴顶/底且水平居中，左右贴左/右且垂直居中", () => {
    const size = 210, band = 58;
    expect(windLabelBox("N", size, band)).toEqual({ x: 0, y: 0, w: size, h: band });
    expect(windLabelBox("S", size, band)).toEqual({ x: 0, y: size - band, w: size, h: band });
    expect(windLabelBox("W", size, band)).toEqual({ x: 0, y: 0, w: band, h: size });
    expect(windLabelBox("E", size, band)).toEqual({ x: size - band, y: 0, w: band, h: size });
    expect(WIND_SLOTS).toEqual(["N", "E", "S", "W"]);
  });
});

describe("isFinalCountdown", () => {
  it("只有 3/2/1 才算最后三秒", () => {
    expect(isFinalCountdown(3)).toBe(true);
    expect(isFinalCountdown(2)).toBe(true);
    expect(isFinalCountdown(1)).toBe(true);
    expect(isFinalCountdown(4)).toBe(false);
    expect(isFinalCountdown(12)).toBe(false);
    expect(isFinalCountdown(null)).toBe(false);
  });
});
