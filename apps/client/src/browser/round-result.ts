import type { RoomResult, RoomSnapshot } from "../protocol.js";
import { element } from "./dom.js";
import { tileChip } from "./tile-chips.js";

const dismissed = new WeakSet<RoomResult>();

export function roundResultPanel(result: RoomResult, snapshot: RoomSnapshot | null): HTMLElement {
  const panel = element("section", { className: "panel" });
  if (!dismissed.has(result)) {
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "本局结算");
    panel.style.cssText = "position:fixed;inset:4vh 3vw;z-index:1000;overflow:auto;background:#17392f;color:#fff;padding:20px;border:2px solid #d5bb78;border-radius:16px;box-shadow:0 0 0 10vmax #0009";
    const close = element("button", { text: "继续" });
    close.onclick = () => { dismissed.add(result); panel.removeAttribute("style"); panel.removeAttribute("role"); close.remove(); };
    panel.append(close);
  }
  panel.append(element("h2", { text: `本局结算 · ${result.reason === "three-winners" ? "三家胡牌" : "流局"}` }));
  const players = result.players ?? result.deltas.map((entry, seat) => ({ playerId: entry.playerId, seat, won: result.winnerSeats.includes(seat), hand: [], melds: [] }));
  for (const player of players) {
    const delta = result.deltas.find((entry) => entry.playerId === player.playerId)?.delta ?? 0;
    const name = snapshot?.players.find((entry) => entry.userId === player.playerId)?.nickname ?? `玩家${player.seat + 1}`;
    const row = element("div", { className: "result-player" });
    row.append(element("p", { text: `${name}${player.won ? " · 已胡" : " · 未胡"}　${delta > 0 ? "赢 +" : delta < 0 ? "输 " : ""}${delta} 分` }));
    const hand = element("div", { className: "melds" });
    for (const tile of [...player.hand].sort((a, b) => a - b)) hand.append(tileChip(tile));
    row.append(hand);
    for (const meld of player.melds) {
      const group = element("div", { className: "meld-group" });
      group.append(element("span", { text: meld.kind === "pong" ? "碰" : meld.concealed ? "暗杠" : "杠" }));
      for (let i = 0; i < (meld.kind === "kong" ? 4 : 3); i++) group.append(tileChip(meld.tile));
      row.append(group);
    }
    panel.append(row);
  }
  return panel;
}
