import { TABLE_HEIGHT, TABLE_WIDTH, box, label, roundRect } from "./widgets.js";

export const NON_TABLE = {
  width: TABLE_WIDTH,
  height: TABLE_HEIGHT,
  ink: "#183A34",
  dim: "#64766F",
  jade: "#176B5B",
  jadeLight: "#DDEAE2",
  paper: "#F4EEDC",
  gold: "#B58B45",
} as const;

export function background(parent: Laya.Sprite, kind: "login" | "lobby" | "group" | "room"): Laya.Image {
  const image = new Laya.Image(`resources/bg/bg-${kind}.png`);
  image.pos(0, 0);
  image.size(TABLE_WIDTH, TABLE_HEIGHT);
  parent.addChild(image);
  return image;
}

export function paperPanel(parent: Laya.Sprite, x: number, y: number, w: number, h: number): Laya.Sprite {
  const shadow = roundRect(parent, x + 10, y + 12, w, h, 28, "#142A2460");
  shadow.mouseEnabled = false;
  return roundRect(parent, x, y, w, h, 28, NON_TABLE.paper, "#C7AE78", 2);
}

export function pageTitle(parent: Laya.Sprite, title: string, subtitle: string): void {
  label(parent, title, 46, { color: NON_TABLE.ink, bold: true }).pos(84, 55);
  label(parent, subtitle, 22, { color: NON_TABLE.dim }).pos(86, 116);
}

export function clear(node: Laya.Sprite): void {
  node.removeChildren();
}

