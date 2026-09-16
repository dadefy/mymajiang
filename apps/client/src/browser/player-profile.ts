import { element } from "./dom.js";
import type { Suit } from "../protocol.js";
import { SUIT_LABEL } from "./tile-label.js";

export function playerProfile(options: { nickname: string; avatarUrl?: string; delta: number | undefined; dealer: boolean; missingSuit: Suit | null }): HTMLElement {
  const profile = element("div", { className: "player-profile" });
  const avatar = element("div", { className: "player-avatar", text: options.nickname.slice(0, 1) || "人" });
  avatar.setAttribute("aria-label", `${options.nickname}的头像`);
  if (options.avatarUrl) {
    const image = element("img"); image.alt = options.nickname; image.src = options.avatarUrl;
    image.referrerPolicy = "no-referrer";
    image.addEventListener("error", () => image.remove(), { once: true });
    avatar.append(image);
  }
  const delta = options.delta;
  const score = element("div", { className: `round-score ${delta === undefined || delta === 0 ? "even" : delta > 0 ? "win" : "loss"}`, text: delta === undefined ? "本局 —" : `本局 ${delta > 0 ? "+" : ""}${delta}` });
  score.setAttribute("aria-label", delta === undefined ? "本局积分暂未同步" : `本局净输赢 ${delta} 分`);
  const badges = element("div", { className: "profile-badges" });
  if (options.dealer) badges.append(element("span", { className: "dealer-badge", text: "庄" }));
  badges.append(element("span", { className: "missing-badge", text: options.missingSuit ? `缺${SUIT_LABEL[options.missingSuit]}` : "未定缺" }));
  profile.append(avatar, score, element("div", { className: "profile-name", text: options.nickname }), badges);
  return profile;
}
