import type { ClientFlow } from "../flow.js";
import type { MatchState } from "../protocol.js";

/**
 * 把服务端下发的动作集合翻成界面按钮。
 *
 * **这张表是照着 `apps/server` 的 `ws-server.ts` 写的** —— 它把引擎
 * `allowedActions()` 的结果**原样透传**：
 * `connection.send({ type: "actions", actions: game.allowedActions(player.id) })`，
 * 中间没有任何改名。所以下面的字符串必须与 `packages/rules` 里的一致。
 *
 * 之前 `/debug` 与 `/multi` 各写了一份判断，于是**一起错了三处**（见 `ServerAction` 的注释）。
 * 收成一个纯函数，两个页面共用并单独测，这类「渲染层等错了名字」的缺陷才挡得住。
 */

/**
 * 引擎 `allowedActions()` 可能返回的全部动作名。
 *
 * 取自 `packages/rules` 的 `MahjongGame.allowedActions`：
 *   * 换三张阶段 —— `swap`
 *   * 定缺阶段 —— `choose-missing`
 *   * 等别人打牌（claiming）—— `pass` / `hu` / `peng` / `kong`
 *   * 自己行牌（playing）—— `discard` / `hu` / `kong-concealed` / `kong-added`
 *
 * ⚠️ 这里**没有** `self-draw` / `concealed-kong` / `added-kong` 这三个名字。
 * 它们是客户端凭空写出来的，服务端从不发 —— 写成它们，对应的按钮就永远不会出现。
 * **行牌阶段的自摸用的也是 `hu`**，与点炮胡同名，只能靠 `phase` 区分。
 */
export type ServerAction =
  | "swap"
  | "choose-missing"
  | "discard"
  | "pass"
  | "hu"
  | "peng"
  | "kong"
  | "kong-concealed"
  | "kong-added";

/** 按钮点下去要调用哪个 `ClientFlow` 方法。 */
export type ActionKind =
  | "hu"
  | "peng"
  | "kong"
  | "pass"
  | "self-draw"
  | "concealed-kong"
  | "added-kong";

export interface ActionButtonSpec {
  label: string;
  kind: ActionKind;
  /** 主操作（胡、自摸）用高亮样式，其余为普通按钮。 */
  primary: boolean;
}

/**
 * 按当前可做的动作生成按钮。
 *
 * `phase` 只参与一件事：**同一个 `hu` 在两个阶段含义不同** ——
 * 行牌阶段是自摸（`flow.selfDraw()`），等别人打牌时才是点炮胡（`flow.claim("hu")`）。
 * 走错一个方向，服务端会用 `Expected phase claiming` 把请求打回来，
 * 表现为「点了按钮弹一句英文错」。
 *
 * `swap` / `choose-missing` / `discard` 不在这里：它们分别由换三张区、定缺区和手牌本身承担。
 */
export function actionButtons(actions: readonly string[], phase: MatchState["phase"]): ActionButtonSpec[] {
  const specs: ActionButtonSpec[] = [];
  const has = (action: ServerAction): boolean => actions.includes(action);

  if (has("hu")) {
    specs.push(phase === "playing"
      ? { label: "自摸", kind: "self-draw", primary: true }
      : { label: "胡", kind: "hu", primary: true });
  }
  if (has("peng")) specs.push({ label: "碰", kind: "peng", primary: false });
  if (has("kong")) specs.push({ label: "杠", kind: "kong", primary: false });
  if (has("kong-concealed")) specs.push({ label: "暗杠", kind: "concealed-kong", primary: false });
  if (has("kong-added")) specs.push({ label: "补杠", kind: "added-kong", primary: false });
  if (has("pass")) specs.push({ label: "过", kind: "pass", primary: false });

  return specs;
}

/** 把按钮落到 `ClientFlow` 上。两个页面共用，免得一处改对、另一处漏改。 */
export function runAction(flow: ClientFlow, kind: ActionKind): void {
  switch (kind) {
    case "hu":
      flow.claim("hu");
      return;
    case "peng":
      flow.claim("peng");
      return;
    case "kong":
      flow.claim("kong");
      return;
    case "pass":
      flow.claim("pass");
      return;
    case "self-draw":
      flow.selfDraw();
      return;
    case "concealed-kong":
      flow.concealedKong();
      return;
    case "added-kong":
      flow.addedKong();
      return;
  }
}
