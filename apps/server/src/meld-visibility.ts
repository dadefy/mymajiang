import type { DeclaredMeld, Tile } from "@mianyang-mahjong/rules";

/**
 * 副露的**可见形态**：碰与明杠带牌值，暗杠可能带也可能不带（见 `maskMelds`）。
 *
 * 客户端 `protocol.ts` 里的同名类型必须与这里保持一致 —— 服务端只是拼对象字面量，
 * 两边没有共享类型，所以改这里就要顺手改那边（以及两个客户端的读取处）。
 */
export interface VisibleMeld {
  kind: "pong" | "kong";
  /** `null` 表示这是**别人扣着的暗杠**，牌值不可见。 */
  tile: Tile | null;
  concealed?: boolean;
}

/**
 * 暗杠对别人亮几张。
 *
 * ⚠️ **杠是四张同值的牌，所以亮任意张数（1~4）都等于亮出牌值。**
 * 这个常量事实上只有两档含义：
 *
 *   * `0`   —— 全扣着。标准打法：对手只知道「那里有四张牌」，不知道是哪一张。
 *   * `> 0` —— 牌值公开。亮 1 张与亮 4 张**信息量完全相同**，只是看起来更像真桌。
 *
 * 所以它不是一个可以「亮一半」的旋钮。若要改成标准打法，把这里改成 `0` 即可 ——
 * 协议与客户端都已经能处理「值不可见」（`tile: null` → 画四张扣着的牌）。
 */
export const REVEALED_CONCEALED_KONG_TILES = 1;

/**
 * 把一副副露裁成「某个观察者能看到的样子」。
 *
 * 暗杠在牌桌上是扣着的，对手看得到那里有四张牌、也知道自己为它付了杠分。
 * **本人当然看得见自己杠的是什么**（`isOwner`）。
 *
 * 裁剪放在服务端而不是「客户端自己忍着不显示」：数据一旦下发，打开开发者工具
 * 或改过的客户端都能直接读出来，那是标准的信息作弊，而且比「看不到对手手牌」
 * 那条更容易被忽略。
 *
 * `revealedTiles` 只在测试里传，用来钉住 0 与 >0 两种口径的行为。
 */
export function maskMelds(
  melds: readonly DeclaredMeld[],
  isOwner: boolean,
  revealedTiles: number = REVEALED_CONCEALED_KONG_TILES,
): VisibleMeld[] {
  return melds.map((meld) => {
    if (isOwner || !meld.concealed) return { ...meld };
    // 亮若干张：四张同值，所以只要不是 0 就等于亮出牌值。
    return revealedTiles > 0
      ? { kind: meld.kind, tile: meld.tile, concealed: true }
      : { kind: meld.kind, tile: null, concealed: true };
  });
}
