import { describe, expect, it } from "vitest";
import { REVEALED_CONCEALED_KONG_TILES, maskMelds } from "./meld-visibility.js";

/**
 * 暗杠对外露到什么程度。
 *
 * 这条是**公平性**约束，不是显示问题：服务端一旦下发牌值，任何打开开发者工具的人
 * 都能读到。所以钉在数据出口这一层测，而不是指望客户端「忍住不显示」。
 */
describe("副露的可见性裁剪", () => {
  const concealedKong = { kind: "kong", tile: 20, concealed: true } as const;
  const openKong = { kind: "kong", tile: 13 } as const;
  const pong = { kind: "pong", tile: 5 } as const;

  it("当前口径：别人的暗杠亮一张（也就是牌值可见）", () => {
    const [meld] = maskMelds([concealedKong], false);
    expect(meld!.tile).toBe(20);
    expect(meld!.concealed).toBe(true);
  });

  it("改成全扣时，别人的暗杠不带牌值", () => {
    // 标准打法的口径 —— 这条测试保证「改成 0」这条路一直是通的。
    const [meld] = maskMelds([concealedKong], false, 0);
    expect(meld!.tile).toBeNull();
    expect(meld!.concealed).toBe(true);
  });

  it("无论哪种口径，都仍然告诉对手「这里有一副暗杠」", () => {
    // 对手该知道的：有人杠了、自己付了杠分、明牌区少了几张。
    for (const revealed of [0, 1, 4]) {
      const [meld] = maskMelds([concealedKong], false, revealed);
      expect(meld!.kind).toBe("kong");
      expect(meld!.concealed).toBe(true);
    }
  });

  it("自己的暗杠照原样保留牌值", () => {
    expect(maskMelds([concealedKong], true, 0)).toEqual([concealedKong]);
  });

  it("碰与明杠本来就是亮的，对谁都带牌值", () => {
    for (const revealed of [0, 1]) {
      const masked = maskMelds([pong, openKong], false, revealed);
      expect(masked.map((meld) => meld.tile)).toEqual([5, 13]);
    }
  });

  it("一次裁剪多副：只按口径处理暗杠", () => {
    expect(maskMelds([pong, concealedKong, openKong], false, 0).map((meld) => meld.tile))
      .toEqual([5, null, 13]);
    expect(maskMelds([pong, concealedKong, openKong], false, 1).map((meld) => meld.tile))
      .toEqual([5, 20, 13]);
  });

  it("不改动传入的副露数组（引擎状态不能被视图层写坏）", () => {
    const melds = [concealedKong, pong];
    const before = melds.map((meld) => ({ ...meld }));
    maskMelds(melds, false, 0);
    expect(melds).toEqual(before);
    expect(melds[0]!.tile).toBe(20);
  });

  it("空数组不出错", () => {
    expect(maskMelds([], false)).toEqual([]);
    expect(maskMelds([], true, 0)).toEqual([]);
  });

  it("口径常量是显式的，改动时能被看见", () => {
    // 「亮一张」这个决定写死在代码里会很难找；它必须是个有名字的常量。
    expect(Number.isInteger(REVEALED_CONCEALED_KONG_TILES)).toBe(true);
    expect(REVEALED_CONCEALED_KONG_TILES).toBeGreaterThanOrEqual(0);
  });
});
