/**
 * 渲染层的公共构件与主题。
 *
 * 第一版以功能为优先：全部用颜色块 + 文字搭建，不依赖任何皮肤资源，
 * 因此不用等待美术素材，也不会因为缺图而白屏。
 */

/** 设计分辨率（竖屏）。引擎缩放模式由 Main.ts 统一设置。 */
export const DESIGN_WIDTH = 750;
export const DESIGN_HEIGHT = 1334;
export const TABLE_WIDTH = 1920;
export const TABLE_HEIGHT = 1080;

export const THEME = {
  pageBg: "#10151f",
  panelBg: "#1c2536",
  panelBg2: "#24304a",
  fieldBg: "#0b0f17",
  accent: "#f0b254",
  accentDark: "#b9822f",
  text: "#e8ecf4",
  textDim: "#8a94a6",
  good: "#58c472",
  bad: "#e05c5c",
  warn: "#e0b64f",
} as const;

const SUIT_NAMES = ["万", "筒", "条"] as const;

/** 牌值 0..26 → 「1万」…「9条」。编码见 packages/rules/src/tiles.ts。 */
export function tileName(tile: number): string {
  return `${(tile % 9) + 1}${SUIT_NAMES[Math.floor(tile / 9)]}`;
}

/** 一组牌按花色与点数排序后拼成一行文字。 */
export function tileRun(tiles: readonly number[]): string {
  return [...tiles].sort((a, b) => a - b).map(tileName).join(" ") || "（无）";
}

export function fmtDelta(delta: number): string {
  return delta > 0 ? `+${delta}` : String(delta);
}

/** 加入父容器的全宽底板。 */
export function box(parent: Laya.Box | Laya.Stage, x: number, y: number, w: number, h: number, bgColor?: string): Laya.Box {
  const view = new Laya.Box();
  view.pos(x, y);
  view.size(w, h);
  if (bgColor) view.bgColor = bgColor;
  parent.addChild(view);
  return view;
}

export interface LabelOptions {
  width?: number;
  align?: string;
  bold?: boolean;
  wordWrap?: boolean;
  color?: string;
}

export function label(parent: Laya.Box, text: string, fontSize: number, options: LabelOptions = {}): Laya.Label {
  const view = new Laya.Label();
  view.text = text;
  view.fontSize = fontSize;
  view.color = options.color ?? THEME.text;
  if (options.width !== undefined) {
    view.width = options.width;
    view.align = options.align ?? "left";
  }
  if (options.bold) view.bold = true;
  if (options.wordWrap) view.wordWrap = true;
  parent.addChild(view);
  return view;
}

/**
 * 纯色文字按钮。LayaAir 的 Button 需要皮肤资源才有观感，
 * 第一版直接用带底色的 Box 承接点击，行为完全可控。
 */
export function textButton(
  parent: Laya.Box,
  text: string,
  x: number,
  y: number,
  w: number,
  h: number,
  bgColor: string,
  onTap: () => void,
): Laya.Box {
  const view = box(parent, x, y, w, h, bgColor);
  const caption = label(view, text, 28, { width: w, align: "center" });
  caption.name = "caption";
  caption.valign = "middle";
  caption.height = h;
  view.on(Laya.Event.CLICK, null, () => onTap());
  return view;
}

/** 改写 textButton 上的文字（例如「准备」↔「取消准备」）。 */
export function setButtonText(button: Laya.Box, text: string): void {
  const caption = button.getChildByName("caption") as Laya.Label | null;
  if (caption) caption.text = text;
}

export interface Field {
  wrapper: Laya.Box;
  input: Laya.TextInput;
}

/** 带底色外框的输入框。 */
export function field(parent: Laya.Box, x: number, y: number, w: number, h: number, prompt: string, maxChars = 0): Field {
  const wrapper = box(parent, x, y, w, h, THEME.fieldBg);
  const input = new Laya.TextInput();
  input.pos(20, (h - 44) / 2);
  input.size(w - 40, 44);
  input.fontSize = 28;
  input.color = THEME.text;
  input.prompt = prompt;
  input.promptColor = THEME.textDim;
  if (maxChars > 0) input.maxChars = maxChars;
  wrapper.addChild(input);
  return { wrapper, input };
}

/** 可滚动列表：Panel 负责裁剪与拖动，内部一列 VBox 由调用方填充。 */
export function scrollList(parent: Laya.Box, x: number, y: number, w: number, h: number): Laya.VBox {
  const panel = new Laya.Panel();
  panel.pos(x, y);
  panel.size(w, h);
  panel.vScrollBarSkin = "";
  panel.hScrollBarSkin = "";
  const list = new Laya.VBox();
  list.pos(0, 0);
  list.width = w;
  list.space = 8;
  panel.addChild(list);
  parent.addChild(panel);
  return list;
}

/** 清空并重建列表行。行数不多，整列重建比逐行 diff 简单可靠。 */
export function refill(list: Laya.VBox, rowCount: number, buildRow: (index: number, row: Laya.Box) => void): void {
  list.removeChildren();
  for (let i = 0; i < rowCount; i += 1) {
    const row = new Laya.Box();
    list.addChild(row);
    buildRow(i, row);
  }
}
