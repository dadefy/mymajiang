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
  /** 低饱和深青灰牌桌。绿色只保留为桌面氛围，不作为整屏高饱和底色。 */
  felt: "#29443E",
  feltDeep: "#1D332F",
  feltEdge: "#171D20",
  /** 深木色桌框。 */
  wood: "#5A4030",
  woodHi: "#755844",
  /** 牌体（真实牌面资源自带牌面，这里只用于底色/背衬）。 */
  ivory: "#F7F4EA",
  ivoryEdge: "#C9BFA6",
  /** 浮层与面板。 */
  pageBg: "#171D20",
  panelBg: "#20282B",
  panelBg2: "#293336",
  panelLine: "#465052",
  fieldBg: "#151C1E",
  /** 强调与语义色：只有这 5 个。 */
  accent: "#C6A15B",
  accentDark: "#987946",
  text: "#F3EFE7",
  textDim: "#B8B3AA",
  textDim2: "#8F908A",
  good: "#6EAE8D",
  bad: "#D97867",
  warn: "#D96C5F",
} as const;

/**
 * 圆角矩形。
 *
 * LayaAir 没有现成的圆角矩形图元，`drawPath` 支持 `arcTo`，用它把四个角画出来。
 * 圆角半径会自动收窄到不超过半宽/半高，避免小尺寸控件画出畸形。
 */
export function roundRect(
  parent: Laya.Sprite,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  fill: string,
  stroke?: string,
  lineWidth = 0,
): Laya.Sprite {
  const node = new Laya.Sprite();
  node.pos(x, y);
  node.size(w, h);
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  const path: unknown[] = [
    ["moveTo", r, 0],
    ["lineTo", w - r, 0], ["arcTo", w, 0, w, r, r],
    ["lineTo", w, h - r], ["arcTo", w, h, w - r, h, r],
    ["lineTo", r, h], ["arcTo", 0, h, 0, h - r, r],
    ["lineTo", 0, r], ["arcTo", 0, 0, r, 0, r],
    ["closePath"],
  ];
  const pen = stroke !== undefined && lineWidth > 0 ? { strokeStyle: stroke, lineWidth } : undefined;
  node.graphics.drawPath(0, 0, path, { fillStyle: fill }, pen);
  parent.addChild(node);
  return node;
}

/** 正圆。`cx/cy` 是圆心（相对父节点），内部换算成左上角定位，保证几何居中。 */
export function circle(
  parent: Laya.Sprite,
  cx: number,
  cy: number,
  radius: number,
  fill: string,
  stroke?: string,
  lineWidth = 0,
): Laya.Sprite {
  const node = new Laya.Sprite();
  node.pos(cx - radius, cy - radius);
  node.size(radius * 2, radius * 2);
  node.graphics.drawCircle(radius, radius, radius, fill, stroke ?? null, lineWidth);
  parent.addChild(node);
  return node;
}

/** 多边形（桌芯四个方向区就是四个三角形）。`points` 是相对本节点的扁平坐标数组。 */
export function poly(
  parent: Laya.Sprite,
  x: number,
  y: number,
  points: number[],
  fill: string,
  stroke?: string,
  lineWidth = 0,
): Laya.Sprite {
  const node = new Laya.Sprite();
  node.pos(x, y);
  node.graphics.drawPoly(0, 0, points, fill, stroke ?? null, lineWidth);
  parent.addChild(node);
  return node;
}

/** 直线（桌芯的两条对角线）。 */
export function line(
  parent: Laya.Sprite,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  color: string,
  width = 1,
): Laya.Sprite {
  const node = new Laya.Sprite();
  node.graphics.drawLine(fromX, fromY, toX, toY, color, width);
  parent.addChild(node);
  return node;
}

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
export function box(parent: Laya.Sprite, x: number, y: number, w: number, h: number, bgColor?: string): Laya.Box {
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

export function label(parent: Laya.Sprite, text: string, fontSize: number, options: LabelOptions = {}): Laya.Label {
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
  parent: Laya.Sprite,
  text: string,
  x: number,
  y: number,
  w: number,
  h: number,
  bgColor: string,
  onTap: () => void,
  /** 圆角半径。0 = 直角（沿用旧观感）；牌桌上的按钮都传半径，做成手游那种圆润按钮。 */
  radius = 0,
): Laya.Box {
  const view = new Laya.Box();
  view.pos(x, y);
  view.size(w, h);
  if (radius > 0) roundRect(view, 0, 0, w, h, radius, bgColor);
  else view.graphics.drawRect(0, 0, w, h, bgColor);
  parent.addChild(view);
  const caption = label(view, text, 28, { width: w, align: "center" });
  caption.name = "caption";
  caption.valign = "middle";
  caption.height = h;
  view.on(Laya.Event.CLICK, null, () => {
    notifyTap();
    onTap();
  });
  return view;
}

/**
 * 点击音的**唯一**挂点。
 *
 * UI 层不 import 表现层 —— 那会绕成环（表现层要用这里的 `THEME` 与版式常量），
 * 所以由 `presentation.ts` 装配时把一个回调塞进来。
 * 这样全工程只有一处接点击音，不必在每个按钮上重复 `playSound`。
 */
let tapNotifier: (() => void) | null = null;

export function setTapSoundHook(notify: (() => void) | null): void {
  tapNotifier = notify;
}

function notifyTap(): void {
  if (tapNotifier !== null) tapNotifier();
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
export function field(parent: Laya.Sprite, x: number, y: number, w: number, h: number, prompt: string, maxChars = 0): Field {
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
export function scrollList(parent: Laya.Sprite, x: number, y: number, w: number, h: number): Laya.VBox {
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
