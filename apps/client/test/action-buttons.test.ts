import { describe, expect, it } from "vitest";
import { actionButtons, type ServerAction } from "../src/browser/action-buttons.js";
import type { MatchState } from "../src/protocol.js";

/**
 * 服务端**真的会下发**的全部动作名。
 *
 * 取自 `packages/rules` 的 `MahjongGame.allowedActions` —— `ws-server.ts` 把它
 * 原样透传（`connection.send({ type: "actions", actions })`），中间没有改名。
 * 这份清单另由规则审计脚本对 300 局实测核对过（动作全集完全一致）。
 */
const ALL_SERVER_ACTIONS: ServerAction[] = [
  "swap",
  "choose-missing",
  "discard",
  "pass",
  "hu",
  "peng",
  "kong",
  "kong-concealed",
  "kong-added",
];

const labels = (actions: readonly string[], phase: MatchState["phase"]): string[] =>
  actionButtons(actions, phase).map((spec) => spec.label);

describe("服务端动作 → 界面按钮", () => {
  it("等别人打牌时，四个响应动作都有按钮", () => {
    expect(labels(["pass", "hu", "peng", "kong"], "claiming")).toEqual(["胡", "碰", "杠", "过"]);
  });

  it("行牌阶段的 hu 是自摸，走 selfDraw 而不是 claim", () => {
    // 服务端对「自摸」和「点炮胡」用的是同一个动作名 `hu`，只能靠阶段区分。
    // 走错方向会被服务端用 `Expected phase claiming` 打回来。
    const specs = actionButtons(["discard", "hu"], "playing");
    expect(specs.map((spec) => spec.label)).toEqual(["自摸"]);
    expect(specs[0]?.kind).toBe("self-draw");
  });

  it("暗杠 / 补杠用的是服务端的名字 kong-concealed / kong-added", () => {
    // 回归用例：这两个之前被写成 concealed-kong / added-kong（服务端从不发这两个名字），
    // 于是暗杠与补杠按钮**永远不会出现** —— 玩家以为「游戏里没有杠」。
    expect(labels(["discard", "kong-concealed", "kong-added"], "playing")).toEqual(["暗杠", "补杠"]);
  });

  it("服务端动作全集里，除换三张/定缺/出牌之外都能变成按钮", () => {
    const kinds = actionButtons(ALL_SERVER_ACTIONS, "claiming").map((spec) => spec.kind).sort();
    // swap / choose-missing / discard 分别由换三张区、定缺区、手牌本身承担，不出现在这里。
    expect(kinds).toEqual(["added-kong", "concealed-kong", "hu", "kong", "pass", "peng"]);
  });

  it("客户端臆造的那三个名字一个都不认", () => {
    // self-draw / concealed-kong / added-kong 在服务端不存在 —— 正是它们让三个按钮失踪。
    expect(actionButtons(["self-draw", "concealed-kong", "added-kong"], "playing")).toEqual([]);
  });

  it("没有可做的动作时不给按钮", () => {
    expect(actionButtons([], "playing")).toEqual([]);
    // `discard` 不算动作按钮：出牌是点手牌。
    expect(actionButtons(["discard"], "playing")).toEqual([]);
    expect(actionButtons(["swap"], "swapping")).toEqual([]);
    expect(actionButtons(["choose-missing"], "missing")).toEqual([]);
  });

  it("自摸与胡标成主操作，其余是普通按钮", () => {
    expect(actionButtons(["hu"], "playing")[0]?.primary).toBe(true);
    expect(actionButtons(["hu"], "claiming")[0]?.primary).toBe(true);
    expect(actionButtons(["peng"], "claiming")[0]?.primary).toBe(false);
    expect(actionButtons(["kong-concealed"], "playing")[0]?.primary).toBe(false);
  });
});
