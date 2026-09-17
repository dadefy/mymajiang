import { element } from "./dom.js";
import type { SeatPresence, Suit } from "../protocol.js";
import { SUIT_LABEL } from "./tile-label.js";

/**
 * 不在场状态显示成什么。
 *
 * `online` **不出徽标** —— 四个人都正常的时候挂四个"在线"只是噪声，
 * 牌桌上要一眼看出的是**异常**的那几个。
 */
const PRESENCE_LABEL: Record<Exclude<SeatPresence, "online">, string> = {
  trustee: "托管中",
  away: "暂离",
  disconnected: "掉线",
};

/**
 * 头像下面的那个数字是**整局（8 小场）累计**净输赢 —— 不是本小场，也不是账号余额。
 *
 * 三个数必须分得清，混起来就出错：
 *   * 本小场（`roundDelta`）换一小场就归零。早先显示的是它，看着像「刚赢的分不见了」；
 *   * 整局累计（`matchDelta`）跨 8 小场连续累加，**这里显示的就是它**；
 *   * 账号积分要到整局结算时才改（见 `match-result.ts`），打的过程中一直是开局前那个值。
 *
 * 数字用等宽数字排版（CSS 的 `tabular-nums`）：本场累计每小场都会跳，
 * 不等宽的话四家的数字会左右抖。
 */
export function playerProfile(options: {
  nickname: string;
  avatarUrl?: string;
  /** 整局累计净输赢；还没开局（没有对局帧）时为 undefined。 */
  matchDelta: number | undefined;
  dealer: boolean;
  missingSuit: Suit | null;
  /**
   * 在场状态（服务端下发）。`trustee` 就是「这个座位服务器在代打」——
   * 另外三家必须看得见，否则会以为对方在思考而不停地等。
   */
  presence?: SeatPresence;
}): HTMLElement {
  const profile = element("div", { className: "player-profile" });
  const avatar = element("div", { className: "player-avatar", text: options.nickname.slice(0, 1) || "人" });
  avatar.setAttribute("aria-label", `${options.nickname}的头像`);
  if (options.avatarUrl) {
    const image = element("img"); image.alt = options.nickname; image.src = options.avatarUrl;
    image.referrerPolicy = "no-referrer";
    image.addEventListener("error", () => image.remove(), { once: true });
    avatar.append(image);
  }
  const total = options.matchDelta;
  const tone = total === undefined || total === 0 ? "even" : total > 0 ? "win" : "loss";
  const score = element("div", {
    className: `match-score ${tone}`,
    text: total === undefined ? "本场 —" : `本场 ${total > 0 ? "+" : ""}${total}`,
  });
  score.setAttribute(
    "aria-label",
    total === undefined ? "本场累计积分暂未同步" : `本场累计净输赢 ${total} 分（一整局 8 小场累加）`,
  );
  const badges = element("div", { className: "profile-badges" });
  if (options.dealer) badges.append(element("span", { className: "dealer-badge", text: "庄" }));
  badges.append(element("span", { className: "missing-badge", text: options.missingSuit ? `缺${SUIT_LABEL[options.missingSuit]}` : "未定缺" }));
  if (options.presence && options.presence !== "online") {
    badges.append(element("span", { className: `presence-badge ${options.presence}`, text: PRESENCE_LABEL[options.presence] }));
  }
  profile.append(avatar, score, element("div", { className: "profile-name", text: options.nickname }), badges);
  return profile;
}
