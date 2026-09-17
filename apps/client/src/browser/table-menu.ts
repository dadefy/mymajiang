import { button, element } from "./dom.js";

/**
 * 牌桌菜单、退出二次确认、托管浮层。
 *
 * 单独一个模块而不是写在页面入口里，是为了能被**渲染探针直接调用**
 * （见 `tools/domcheck/check-takeover-flow.mjs`）：入口脚本一 import 就会去连服务端，
 * 而这三块恰恰是"数据全对、画错了也看不出来"的地方 —— 少一个 append、
 * 类名写错，单测与协议层验收全绿，屏幕上却什么都没有。
 *
 * 三个函数都只接收回调、不依赖 ClientFlow，所以能在没有服务端的环境里跑。
 */

export interface TableMenuHandlers {
  /** 继续游戏：收起菜单，回到牌桌。 */
  onResume: () => void;
  /** 返回大厅：暂时离开牌桌，控制权仍在玩家手上。 */
  onBackToLobby: () => void;
  /** 退出游戏：打开二次确认（真正的转换在确认之后）。 */
  onQuit: () => void;
}

/**
 * 牌桌菜单：继续游戏 / 返回大厅 / 退出游戏。
 *
 * 三个动作的语义完全不同，所以文案里把差别写清楚 ——
 * 「返回大厅」只是暂时离开牌桌（控制权还在玩家手上，回来直接接着打）；
 * 「退出游戏」是把座位交给服务器托管（要回来得点「重新接管」）。
 */
export function tableMenuOverlay(handlers: TableMenuHandlers): HTMLElement {
  const card = element("div", { className: "overlay-card" });
  card.append(
    element("h2", { text: "牌桌菜单" }),
    element("p", { text: "返回大厅：暂时离开牌桌，你仍属于这一局，随时可以回来接着打。" }),
    element("p", { text: "退出游戏：由服务器接管你的座位并自动代打，牌、座次与积分都保留。" }),
    element("div", { className: "actions" },
      button("继续游戏", handlers.onResume, "primary"),
      button("返回大厅", handlers.onBackToLobby),
      button("退出游戏", handlers.onQuit),
    ),
  );
  return element("div", { className: "overlay-mask" }, card);
}

export interface QuitConfirmHandlers {
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * 退出前的二次确认。
 *
 * 这个动作不可逆地交出了操作权（要拿回来得点「重新接管」），
 * 所以必须让人明确点一次，而不是在一次误触里就离开牌桌。
 * 文案要说清三件事：会托管、什么时候能回来、按哪个键反悔。
 */
export function quitConfirmOverlay(handlers: QuitConfirmHandlers): HTMLElement {
  const card = element("div", { className: "overlay-card" });
  card.append(
    element("h2", { text: "确定退出当前游戏吗？" }),
    element("p", { text: "退出后系统将自动托管你的座位，" }),
    element("p", { text: "本次大局结束前你可以回来重新接管。" }),
    element("div", { className: "actions" },
      button("取消", handlers.onCancel),
      button("确认退出", handlers.onConfirm, "primary"),
    ),
  );
  return element("div", { className: "overlay-mask" }, card);
}

export interface TrusteeOverlayOptions {
  roundNumber: number;
  /** 一整局共几小场。由服务端下发，这里不硬编 8。 */
  totalRounds: number;
  onTakeover: () => void;
}

/**
 * 托管浮层：压在后牌桌正中，**不全屏遮挡** —— 牌面看得见正是这个状态要传达的信息
 * （另外三家在替你打）。这里只是不能再点，并给出唯一的出路：重新接管。
 *
 * ⚠️ 它**不是**权限判断：能不能接管完全由服务端验证（token、座位归属、
 * 大局是否仍在进行）。客户端只负责把按钮摆出来。
 */
export function trusteeOverlay(options: TrusteeOverlayOptions): HTMLElement {
  return element("div", { className: "trustee-banner" },
    element("strong", { text: "你的牌局正在托管中" }),
    element("span", { text: `当前第 ${options.roundNumber} / ${options.totalRounds} 局` }),
    button("重新接管", options.onTakeover, "primary"),
  );
}
