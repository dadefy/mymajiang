import { circle, label } from "./widgets.js";

/**
 * 「麻雀精灵」牌桌的视觉皮肤层。
 *
 * 这里只放**画面上**的东西：色板、A2 资源的内容框表、九宫格底板、圆形头像、
 * 牌面托底、图标按钮、圆环角度遮罩。业务状态一个都不碰 —— 谁能动、谁不能动，
 * 仍然由 `RoomPage` 从服务端帧里算。
 *
 * 之所以单开一个文件而不是往 `widgets.ts` 里加：`widgets.ts` 的 `THEME` 被大厅
 * （HomePage / ChatPage / SocialDialogs，A1 的地盘）共用，牌桌换皮不能顺手改到那边去。
 */

/** 牌桌专用色板。取 A2 图标系统的同一套 token（manifest.md 顶部）。 */
export const TABLE_THEME = {
  gold: "#D9B66F",
  goldDeep: "#9A7946",
  goldSoft: "#EAD1A0",
  cream: "#FDF6E9",
  ivory: "#F7F2E4",
  jade: "#3E8C74",
  jadeDeep: "#17423A",
  jadeDark: "#0E2A26",
  ink: "#12222A",
  inkSoft: "#0C181E",
  lake: "#5B8FC8",
  vermilion: "#C05748",
  /** 就地成功提示（「已复制」）：比翡翠绿亮一档，墨底上才读得清。 */
  jadeLight: "#7FC79E",
  /** 分数三态：正=暖金、负=柔和冷灰蓝、0=象牙灰。不用股市红绿。 */
  scoreUp: "#EAD1A0",
  scoreDown: "#8FA9B8",
  scoreFlat: "#C9C3B4",
  /** 对局中压在背景上的青墨：让白牌从背景里浮出来（约 22%）。 */
  veil: "#081A1E",
} as const;

/** 派生底板资源（由 `tools/gen-table-textures.py` 生成，构建期不依赖 Python）。 */
export const SKIN = {
  bg: "resources/bg/table-lake.jpg",
  slab: "resources/table/slab.png",
  tileFace: "resources/table/tile-face.png",
  tileBackVertical: "resources/tiles/tile_back_vertical.png",
  tileBackHorizontal: "resources/tiles/tile_back_horizontal.png",
  tileSideLeft: "resources/tiles/tile_side_view_left.png",
  tileSideRight: "resources/tiles/tile_side_view_right.png",
  tileEdgeBottom: "resources/tiles/tile_edge_bottom.png",
  tileShadow: "resources/tiles/tile_shadow.png",
  tileWallVertical: "resources/tiles/tile_wall_stack_vertical.png",
  tileWallHorizontal: "resources/tiles/tile_wall_stack_horizontal.png",
  panel: "resources/table/panel-ink.png",
} as const;

/** 九宫格留边：和生成脚本里的圆角半径一致，改一处要改两处。 */
const GRID = { panel: 26 } as const;

/** 石板在 1920×1080 上的落点（生成画布含 46px 落影留白）。 */
export const SLAB = { x: 104, y: 93, w: 1712, h: 982 } as const;

/* ==================================================================
 * A2 资源
 * ==================================================================*/

/**
 * 本次接入的 A2 资源（只取牌桌必需项）。
 *
 * 文件名与 `mj-icon-design/png/` 完全一致 —— manifest 的集成约束里写明不许改名、
 * 不许复制第二套，所以这里按原名引用。
 */
export type A2Key =
  | "btn_action_pass" | "btn_action_peng" | "btn_action_gang" | "btn_action_hu"
  | "ring_active_player" | "ring_countdown_track" | "ring_countdown_fill"
  | "badge_dealer" | "badge_missing_wan" | "badge_missing_tiao" | "badge_missing_tong"
  | "icon_trustee" | "icon_takeover" | "icon_table_chat" | "icon_voice" | "icon_emoji"
  | "icon_back" | "icon_settings" | "icon_rules" | "icon_exit" | "icon_copy"
  | "icon_net_good" | "icon_net_mid" | "icon_net_bad"
  | "divider_gold" | "tag_jade_base";

/**
 * 每枚资源的「画布尺寸 + 可见内容框」。
 *
 * A2 把图形画在 256×256（分隔纹 512×64、玉石标签 256×128）的透明画布正中，
 * 四周留了一圈空白。要对齐布局就得按**内容框**摆，而不是按画布摆。
 * 又因为不许裁源图、不许另存一份裁剪版，所以这里把内容框记下来，
 * 由 `a2()` 在摆放时按比例反向补偿 —— 属于 manifest 允许的「缩放 / 锚点 / 容器」。
 */
const A2_ART: Record<A2Key, { canvas: [number, number]; box: [number, number, number, number] }> = {
  btn_action_pass: { canvas: [256, 256], box: [12, 68, 232, 120] },
  btn_action_peng: { canvas: [256, 256], box: [12, 68, 232, 120] },
  btn_action_gang: { canvas: [256, 256], box: [12, 68, 232, 120] },
  btn_action_hu: { canvas: [256, 256], box: [11, 67, 234, 122] },
  ring_active_player: { canvas: [256, 256], box: [8, 8, 240, 240] },
  ring_countdown_track: { canvas: [256, 256], box: [17, 17, 222, 222] },
  ring_countdown_fill: { canvas: [256, 256], box: [17, 16, 222, 223] },
  badge_dealer: { canvas: [256, 256], box: [22, 22, 212, 212] },
  badge_missing_wan: { canvas: [256, 256], box: [21, 71, 214, 114] },
  badge_missing_tiao: { canvas: [256, 256], box: [21, 71, 214, 114] },
  badge_missing_tong: { canvas: [256, 256], box: [21, 71, 214, 114] },
  icon_trustee: { canvas: [256, 256], box: [27, 74, 203, 120] },
  icon_takeover: { canvas: [256, 256], box: [32, 74, 193, 120] },
  icon_table_chat: { canvas: [256, 256], box: [41, 57, 174, 142] },
  icon_voice: { canvas: [256, 256], box: [67, 37, 122, 142] },
  icon_emoji: { canvas: [256, 256], box: [34, 34, 188, 188] },
  icon_back: { canvas: [256, 256], box: [79, 61, 136, 134] },
  icon_settings: { canvas: [256, 256], box: [28, 28, 200, 200] },
  icon_rules: { canvas: [256, 256], box: [40, 62, 176, 132] },
  icon_exit: { canvas: [256, 256], box: [47, 51, 175, 154] },
  icon_copy: { canvas: [256, 256], box: [53, 41, 171, 167] },
  icon_net_good: { canvas: [256, 256], box: [67, 125, 122, 89] },
  icon_net_mid: { canvas: [256, 256], box: [67, 125, 122, 89] },
  icon_net_bad: { canvas: [256, 256], box: [67, 125, 122, 89] },
  divider_gold: { canvas: [512, 64], box: [24, 11, 464, 42] },
  tag_jade_base: { canvas: [256, 128], box: [11, 25, 234, 78] },
};

/**
 * 放一枚 A2 资源，让它的**可见内容**正好落进 `(x, y, w, h)`。
 *
 * - `fit`（默认）：等比缩放到能装下内容框，居中留白。胶囊/圆环不会被拉变形。
 * - `fill`：按 `(x, y, w, h)` 拉伸。只给本来就打算铺满的标签底板用。
 */
export function a2(
  parent: Laya.Sprite,
  key: A2Key,
  x: number,
  y: number,
  w: number,
  h: number,
  mode: "fit" | "fill" = "fit",
): Laya.Image {
  const art = A2_ART[key];
  const [bx, by, bw, bh] = art.box;
  // fit = 等比装进内容框（胶囊/圆环不变形，四周留白）；fill = 两轴各自铺满。
  const uniform = Math.min(w / bw, h / bh);
  const scaleX = mode === "fill" ? w / bw : uniform;
  const scaleY = mode === "fill" ? h / bh : uniform;
  const dw = bw * scaleX;
  const dh = bh * scaleY;
  const node = new Laya.Image();
  node.skin = `resources/ui/${key}.png`;
  node.size(art.canvas[0] * scaleX, art.canvas[1] * scaleY);
  node.pos(x + (w - dw) / 2 - bx * scaleX, y + (h - dh) / 2 - by * scaleY);
  parent.addChild(node);
  return node;
}

/** 内容框的实际宽高比 —— 调用方按它挑按钮尺寸，免得把胶囊拉扁。 */
export function a2Aspect(key: A2Key): number {
  const [bw, bh] = A2_ART[key].box.slice(2);
  return bw / bh;
}

/* ==================================================================
 * 底板
 * ==================================================================*/

/** 九宫格底板：四角不变形地铺满任意尺寸。 */
export function plate(
  parent: Laya.Sprite,
  x: number,
  y: number,
  w: number,
  h: number,
  skin: string,
  grid: number,
): Laya.Image {
  const node = new Laya.Image();
  node.skin = skin;
  // `Laya.Image.sizeGrid` 是逗号串「上,右,下,左」—— 数组那套是 AutoBitmap 的签名。
  node.sizeGrid = `${grid},${grid},${grid},${grid}`;
  node.pos(x, y);
  node.size(w, h);
  parent.addChild(node);
  return node;
}

/** 墨青面板（半透明 + 香槟金细边）。所有浮层、座位卡、牌匾共用这一种底。 */
export function inkPanel(
  parent: Laya.Sprite, x: number, y: number, w: number, h: number,
): Laya.Image {
  return plate(parent, x, y, w, h, SKIN.panel, GRID.panel);
}

/**
 * 牌背底板。上家 36×40、左右 40×30、副露 38×54 三种比例共用一张。
 *
 * 这张图里有一圈**内缩的描金边**，九宫格会把那圈边钉死在角上、拉花中段，
 * 36×40 的小牌直接糊成一颗绿椭圆。所以这里整张等比缩放，不走 plate。
 */
export function tileBack(
  parent: Laya.Sprite, x: number, y: number, w: number, h: number,
  view: "top" | "left" | "right" | "concealed" = "concealed",
): Laya.Image {
  const source = view === "top" ? { skin: SKIN.tileBackHorizontal, ratio: 358 / 250 }
    : view === "left" ? { skin: SKIN.tileSideLeft, ratio: 245 / 358 }
    : view === "right" ? { skin: SKIN.tileSideRight, ratio: 246 / 358 }
    : { skin: SKIN.tileBackVertical, ratio: 250 / 358 };
  const targetRatio = w / h;
  const drawW = targetRatio > source.ratio ? h * source.ratio : w;
  const drawH = targetRatio > source.ratio ? h : w / source.ratio;
  const node = new Laya.Image();
  node.skin = source.skin;
  node.pos(x + (w - drawW) / 2, y + (h - drawH) / 2);
  node.size(drawW, drawH);
  parent.addChild(node);
  return node;
}

/** 两层牌墙只作余牌视觉提示；实际数量仍完全取服务端 `tilesLeft`。 */
export function tileWall(
  parent: Laya.Sprite, x: number, y: number, w: number, h: number, orientation: "vertical" | "horizontal",
): Laya.Image {
  const node = new Laya.Image();
  node.skin = orientation === "vertical" ? SKIN.tileWallVertical : SKIN.tileWallHorizontal;
  node.pos(x, y);
  node.size(w, h);
  parent.addChild(node);
  return node;
}

/**
 * 往容器里铺一张「立着的牌」：象牙底板 + 既有牌面线稿。
 *
 * 牌面一张都不重画（任务书第十/十一条），这里只在它**底下**垫一层有厚度、
 * 有受光的象牙板，再把线稿原来的黑框当牌边收口。
 * 三处用到的比例（100×143 / 42×60 / 38×54）都是 250:358，等比缩放不会拉伸。
 */
export function addTileFace(
  container: Laya.Sprite, w: number, h: number, glyphSkin: string,
): Laya.Image {
  const shadow = new Laya.Image();
  shadow.skin = SKIN.tileShadow;
  shadow.pos(1, 2);
  shadow.size(w, h);
  shadow.alpha = 0.45;
  container.addChild(shadow);
  const face = new Laya.Image();
  face.skin = SKIN.tileFace;
  face.size(w, h);
  container.addChild(face);
  const glyph = new Laya.Image();
  glyph.skin = glyphSkin;
  glyph.size(w, h);
  container.addChild(glyph);
  const edge = new Laya.Image();
  const edgeH = Math.max(3, h * (48 / 358));
  edge.skin = SKIN.tileEdgeBottom;
  edge.pos(0, h - edgeH);
  edge.size(w, edgeH);
  edge.alpha = 0.82;
  container.addChild(edge);
  return glyph;
}

/**
 * 摆在 `(x, y)` 的一张立牌，返回那张**牌本身**（不是容器）—— 手牌要在它身上挂点击、
 * 缩放与抬升，牌河 / 副露只用来描边，所以直接给节点最省事。
 */
export function faceTile(
  parent: Laya.Sprite, x: number, y: number, w: number, h: number, glyphSkin: string,
): Laya.Sprite {
  const node = new Laya.Sprite();
  node.pos(x, y);
  node.size(w, h);
  addTileFace(node, w, h, glyphSkin);
  parent.addChild(node);
  return node;
}

/**
 * 手牌那张立牌：与 `faceTile` 同一套底板，只多一件事 —— 允许**绕中心**轻微放大。
 *
 * 没用 `pivot`：它的语义要和 `pos` 的先后顺序一起看，容易读错，这里直接把左上角按
 * 放大增量回挪一半，视觉上等价，坐标语义仍然是「左上角」。
 * 描边留给调用方往本节点上加 —— 加在牌面**底下**，不会盖住万/筒/条的花色。
 */
export function handTile(
  parent: Laya.Sprite, x: number, y: number, w: number, h: number, glyphSkin: string, scale = 1,
): Laya.Sprite {
  const node = faceTile(parent, x - ((scale - 1) * w) / 2, y - ((scale - 1) * h) / 2, w, h, glyphSkin);
  if (scale !== 1) node.scale(scale, scale);
  return node;
}

/* ==================================================================
 * 头像 / 图标按钮
 * ==================================================================*/

/**
 * 圆形头像：服务端有 `avatarUrl` 就圆形裁切，没有就用昵称首字坐在玉底上。
 *
 * LayaAir 3.4 没有 `CircleMask` 这类组件，但 `Sprite.mask` 支持矢量图形，
 * 所以用一个画了正圆的子节点当遮罩即可 —— 比给每个玩家烤一张头像便宜得多。
 */
export function avatarDisc(
  parent: Laya.Sprite,
  x: number,
  y: number,
  size: number,
  url: string | undefined,
  name: string,
): Laya.Sprite {
  const node = new Laya.Sprite();
  node.pos(x, y);
  node.size(size, size);
  const r = size / 2;
  circle(node, r, r, r, TABLE_THEME.jadeDark, TABLE_THEME.goldDeep, 2);

  if (url !== undefined && /^https?:/.test(url)) {
    const image = new Laya.Image();
    image.skin = url;
    image.size(size, size);
    const mask = new Laya.Sprite();
    mask.graphics.drawCircle(r, r, r - 1, "#FFFFFF");
    image.addChild(mask);
    image.mask = mask;
    node.addChild(image);
  } else {
    const initial = label(node, name.slice(0, 1) || "＋", Math.round(size * 0.44), {
      width: size, align: "center", bold: true, color: TABLE_THEME.cream,
    });
    initial.pos(0, 0);
    initial.height = size;
    initial.valign = "middle";
  }
  parent.addChild(node);
  return node;
}

/**
 * 侧栏图标按钮：玉色圆底 + A2 图标 + 下方短文字。
 *
 * 任务书要的不是网页默认按钮，所以底板、描边、命中区都由这里说了算；
 * 图标本身一律用 A2 现成的那几枚，不再画第二套。
 */
export function iconButton(
  parent: Laya.Sprite,
  x: number,
  y: number,
  size: number,
  icon: A2Key,
  caption: string,
  onTap: () => void,
): Laya.Sprite {
  const node = new Laya.Sprite();
  node.pos(x, y);
  node.size(size, size + 28);
  circle(node, size / 2, size / 2, size / 2 - 1, "#12282388", TABLE_THEME.goldDeep, 2);
  a2(node, icon, size * 0.2, size * 0.2, size * 0.6, size * 0.6);
  const text = label(node, caption, 22, { width: size + 24, align: "center", color: TABLE_THEME.ivory });
  text.pos(-12, size + 2);
  text.height = 26;
  text.valign = "middle";
  node.on(Laya.Event.CLICK, null, () => onTap());
  parent.addChild(node);
  return node;
}

/* ==================================================================
 * 圆环角度裁剪
 * ==================================================================*/

/**
 * 给一个节点套上**扇形遮罩**，用来按剩余时间裁剪倒计时环。
 *
 * manifest 的集成约束第 2 条：`ring_countdown_fill` 只能按角度裁剪，
 * 严禁靠缩放整圈来表现进度 —— 所以这里画一个扇形当 mask，而不是改 scaleX。
 * 返回遮罩节点，`setPie` 每帧改它的角度。
 */
export function pieMask(target: Laya.Sprite, radius: number, fromRad: number, toRad: number): Laya.Sprite {
  const mask = new Laya.Sprite();
  mask.graphics.drawPie(radius, radius, radius, fromRad, toRad, "#FFFFFF");
  target.addChild(mask);
  target.mask = mask;
  return mask;
}

/** 改写扇形遮罩的角度（`drawPie` 的起止角，弧度制）。 */
export function setPie(mask: Laya.Sprite, radius: number, fromRad: number, toRad: number): void {
  mask.graphics.clear();
  mask.graphics.drawPie(radius, radius, radius, fromRad, toRad, "#FFFFFF");
}
