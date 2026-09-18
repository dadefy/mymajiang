import { tileAsset } from "../../ui/table-model.js";
import { THEME } from "../../ui/widgets.js";
import type { AnimationCue, AnimationDriver, ConfirmedAnimation } from "./AnimationCoordinator.js";
import {
  ACTIVE_PLAYER_LOOP_MS, ANIMATION_ASSET, DISCARD_SCALE_UP, DRAW_SLIDE_IN, DURATION_MS,
  RING_BREATH_ALPHA, RING_BREATH_SCALE, SELECT_LIFT, actionRowRect, avatarRect, dialRect,
  handTileRect, meldRect, riverCellRect, ringRectFor, tableCenter,
  type AnimationPayload, type Rect, type SeatSide,
} from "./animation-spec.js";

/** 一组在途动画。 */
interface Group {
  cue: AnimationCue;
  nodes: Laya.Sprite[];
  finish: () => void;
}

/** 自己调一次把节点挂进覆盖层并计入这一组。 */
type Add = (node: Laya.Sprite) => void;

/**
 * LayaAir 动画驱动：只管**画**，不管状态。
 *
 * 三条硬约束：
 * 1. 覆盖层 `mouseThrough`，动画期间玩家照样能点 —— 动画不挡操作。
 * 2. 只用 Tween / alpha / scale / position / mask，不做实时模糊、不铺全屏粒子、不加多层阴影。
 * 3. 结束即销毁自己，最终画面始终由牌桌按真实状态画出的那一份决定。出牌那类飞行
 *    用的是牌桌渲染同一格的坐标，所以动画结束必然与真实弃牌对齐。
 */
export class LayaAnimationDriver implements AnimationDriver {
  private readonly overlay: Laya.Sprite;
  private readonly groups = new Map<string, Group>();
  /** 持续态：当前玩家呼吸环与倒计时环，不走 eventId 生命周期。 */
  private activeRing: Laya.Image | null = null;
  private activeRingSide: SeatSide | null = null;
  private countdown: Laya.Sprite | null = null;
  private countdownFill: Laya.Image | null = null;
  private countdownMask: Laya.Sprite | null = null;
  private countdownUrgent: Laya.Sprite | null = null;
  private disposed = false;

  constructor(parent: Laya.Sprite, width: number, height: number) {
    this.overlay = new Laya.Sprite();
    this.overlay.size(width, height);
    // 不吃任何命中：动画绝不能吞掉一次点牌。
    this.overlay.mouseEnabled = false;
    this.overlay.mouseThrough = true;
    parent.addChild(this.overlay);
  }

  get overlayNode(): Laya.Sprite { return this.overlay; }

  get inFlight(): number { return this.groups.size; }

  play(event: ConfirmedAnimation): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const duration = DURATION_MS[event.cue] ?? 300;
    return new Promise<void>((resolve) => {
      const group: Group = { cue: event.cue, nodes: [], finish: resolve };
      this.groups.set(event.eventId, group);
      const add: Add = (node) => {
        this.overlay.addChild(node);
        group.nodes.push(node);
      };
      const done = Laya.Handler.create(this, () => this.close(event.eventId));
      this.render(event.cue, event.payload ?? {}, add, done, duration);
      if (group.nodes.length === 0) this.close(event.eventId);
      // 兜底：万一某条 cue 忘了接收尾，也得到点销毁，不能留下永久的幽灵节点。
      Laya.timer.once(duration + 600, this, () => {
        if (this.groups.has(event.eventId)) this.close(event.eventId);
      });
    });
  }

  cancelCue(cue: AnimationCue): void {
    for (const [id, group] of [...this.groups]) {
      if (group.cue === cue) this.close(id);
    }
  }

  cancelAll(): void {
    for (const id of [...this.groups.keys()]) this.close(id);
  }

  /** 离开牌桌 / 页面销毁：连持续态的环一起收掉，别留一个还在呼吸的节点。 */
  dispose(): void {
    this.disposed = true;
    this.cancelAll();
    this.setActivePlayer(null);
    this.setCountdown(null, null);
    Laya.timer.clearAll(this);
    this.overlay.destroy(true);
  }

  /* ------------------------------------------------------------------ *
   * 持续态
   * ------------------------------------------------------------------ */

  /** 当前出牌者的呼吸环；传 `null` 收掉。同一座位重复调用不会重建。 */
  setActivePlayer(side: SeatSide | null): void {
    if (this.disposed || side === this.activeRingSide) return;
    this.activeRingSide = side;
    this.activeRing?.destroy();
    this.activeRing = null;
    if (side === null) return;
    const rect = ringRectFor(avatarRect(side), 10);
    const ring = new Laya.Image();
    ring.skin = ANIMATION_ASSET.ringActive;
    ring.size(rect.w, rect.h);
    // 缩放绕中心：先定轴心再定位。
    ring.pivot(rect.w / 2, rect.h / 2);
    ring.pos(rect.x + rect.w / 2, rect.y + rect.h / 2);
    this.overlay.addChild(ring);
    this.activeRing = ring;
    this.breathe(ring);
  }

  /**
   * 倒计时环。
   *
   * `ring_countdown_fill` **按角度裁剪**（一张画了扇形的 mask 节点），不缩放整圈 ——
   * 缩放会把圆环压成椭圆，视觉稿明令禁止。5 秒以下再叠一层朱红弧做分档强调。
   */
  setCountdown(seconds: number | null, totalSeconds: number | null): void {
    if (this.disposed) return;
    if (seconds === null || totalSeconds === null || totalSeconds <= 0) {
      if (this.countdown) this.destroyCountdown();
      return;
    }
    const rect = ringRectFor(dialRect(), -6);
    if (!this.countdown) this.buildCountdown(rect);
    const radius = rect.w / 2;
    const percent = clamp(seconds / totalSeconds, 0, 1);
    const sweep = -90 + 360 * percent;
    this.countdownMask?.graphics.clear();
    // 扇形从正上方起、顺时针扫过剩余比例；mask 自身不进显示树。
    this.countdownMask?.graphics.drawPie(radius, radius, radius + 2, -90, sweep, "#FFFFFF");
    if (this.countdownUrgent) {
      const urgent = seconds <= 5;
      this.countdownUrgent.visible = urgent;
      if (urgent) {
        this.countdownUrgent.graphics.clear();
        this.countdownUrgent.graphics.drawPie(radius, radius, radius - 8, -90, sweep, "#00000000", THEME.warn, 5);
      }
    }
    if (this.countdownFill) this.countdownFill.alpha = seconds <= 10 ? 1 : 0.7;
  }

  private destroyCountdown(): void {
    this.countdown?.destroy();
    this.countdown = null;
    this.countdownFill = null;
    this.countdownMask = null;
    this.countdownUrgent = null;
  }

  private buildCountdown(rect: Rect): void {
    const layer = new Laya.Sprite();
    layer.size(rect.w, rect.h);
    layer.pos(rect.x, rect.y);
    layer.mouseEnabled = false;
    layer.mouseThrough = true;
    this.overlay.addChild(layer);
    const track = new Laya.Image();
    track.skin = ANIMATION_ASSET.ringTrack;
    track.size(rect.w, rect.h);
    layer.addChild(track);
    const fill = new Laya.Image();
    fill.skin = ANIMATION_ASSET.ringFill;
    fill.size(rect.w, rect.h);
    const mask = new Laya.Sprite();
    mask.size(rect.w, rect.h);
    fill.mask = mask;
    layer.addChild(fill);
    const urgent = new Laya.Sprite();
    urgent.size(rect.w, rect.h);
    urgent.visible = false;
    layer.addChild(urgent);
    this.countdown = layer;
    this.countdownFill = fill;
    this.countdownMask = mask;
    this.countdownUrgent = urgent;
  }

  /** 呼吸：一个来回 2 秒，只动 alpha 与极小的 scale。 */
  private breathe(ring: Laya.Image): void {
    if (this.disposed || this.activeRing !== ring) return;
    const half = ACTIVE_PLAYER_LOOP_MS / 2;
    Laya.Tween.to(ring, {
      alpha: RING_BREATH_ALPHA[1], scaleX: RING_BREATH_SCALE[1], scaleY: RING_BREATH_SCALE[1],
    }, half, Laya.Ease.sineInOut, Laya.Handler.create(this, () => {
      if (this.disposed || this.activeRing !== ring) return;
      Laya.Tween.to(ring, {
        alpha: RING_BREATH_ALPHA[0], scaleX: RING_BREATH_SCALE[0], scaleY: RING_BREATH_SCALE[0],
      }, half, Laya.Ease.sineInOut, Laya.Handler.create(this, () => this.breathe(ring)));
    }));
  }

  /* ------------------------------------------------------------------ *
   * 内部分派与基础笔触
   * ------------------------------------------------------------------ */

  private render(cue: AnimationCue, payload: AnimationPayload, add: Add, done: Laya.Handler, duration: number): void {
    switch (cue) {
      case "select-tile": this.cueSelectTile(payload, add, done, duration); break;
      case "draw": this.cueDraw(payload, add, done, duration); break;
      case "discard": this.cueDiscard(payload, add, done, duration); break;
      case "last-discard": this.cueRiverFlash(payload, add, done, duration); break;
      case "peng": this.cueMeld(payload, 3, add, done, duration); break;
      case "kong": this.cueMeld(payload, 4, add, done, duration); break;
      case "hu": this.cueStamp(payload, add, done, duration); break;
      case "pass": this.cuePass(payload, add, done, duration); break;
      case "action-buttons": this.cueActionButtons(add, done, duration); break;
      case "turn-highlight": this.cueTurnHighlight(payload, add, done, duration); break;
      case "countdown-final": this.cueDialPulse(add, done, duration); break;
      case "trustee-on": this.cueTrustee(true, add, done, duration); break;
      case "trustee-off": this.cueTrustee(false, add, done, duration); break;
      case "round-finished": this.cueResultCard(payload, false, add, done, duration); break;
      case "match-finished": this.cueResultCard(payload, true, add, done, duration); break;
      case "screen-transition": this.cueScreenTransition(add, done, duration); break;
      case "score-float": this.cueScoreFloat(payload, add, done, duration); break;
      case "win-pattern": this.cueScoreFloat(payload, add, done, duration); break;
      case "swap": case "choose-missing": this.cueHandSweep(add, done, duration); break;
    }
  }

  private close(id: string): void {
    const group = this.groups.get(id);
    if (!group) return;
    this.groups.delete(id);
    for (const node of group.nodes) {
      Laya.Tween.clearAll(node);
      node.destroy();
    }
    group.finish();
  }

  /** 淡入 → 位移 → 淡出；淡出结束即收掉整组。 */
  private fade(node: Laya.Sprite, add: Add, done: Laya.Handler, peak: number, up: number, duration: number, hold = 0): void {
    node.alpha = 0;
    add(node);
    Laya.Tween.to(node, { alpha: peak, y: node.y - up }, duration * 0.4, Laya.Ease.cubicOut);
    Laya.Tween.to(node, { alpha: 0 }, duration * 0.6, Laya.Ease.quadIn, done, duration * 0.4 + hold);
  }

  private box(rect: Rect, color: string, radius = 8): Laya.Sprite {
    const node = new Laya.Sprite();
    node.size(rect.w, rect.h);
    node.pos(rect.x, rect.y);
    node.graphics.drawRoundRect(0, 0, rect.w, rect.h, radius, radius, radius, radius, color);
    return node;
  }

  private outline(rect: Rect, color: string, width = 3): Laya.Sprite {
    const node = new Laya.Sprite();
    node.size(rect.w + width * 2, rect.h + width * 2);
    node.pos(rect.x - width, rect.y - width);
    node.graphics.drawRoundRect(0, 0, rect.w + width * 2, rect.h + width * 2, 12, 12, 12, 12, "#00000000", color, width);
    return node;
  }

  private text(content: string, size: number, color: string): Laya.Label {
    const label = new Laya.Label();
    label.text = content;
    label.fontSize = size;
    label.color = color;
    label.bold = true;
    label.align = "center";
    label.valign = "middle";
    label.width = size * Math.max(3, content.length) + 40;
    label.height = size + 18;
    return label;
  }

  private tileImage(rect: Rect, tile: number): Laya.Image {
    const image = new Laya.Image();
    image.skin = tileAsset(tile);
    image.size(rect.w, rect.h);
    image.pos(rect.x, rect.y);
    return image;
  }

  private ring(rect: Rect, color: string, width: number, radiusRatio = 0.5): Laya.Sprite {
    const node = new Laya.Sprite();
    node.size(rect.w, rect.h);
    node.pos(rect.x, rect.y);
    node.pivot(rect.w / 2, rect.h / 2);
    node.graphics.drawCircle(rect.w / 2, rect.h / 2, Math.min(rect.w, rect.h) * radiusRatio - 2, "#00000000", color, width);
    return node;
  }

  /* ------------------------------------------------------------------ *
   * 各事件
   * ------------------------------------------------------------------ */

  /**
   * 选牌：一张同牌面的幽灵牌上抬 24px、轻微放大、带淡金描边，闪一下即收。
   *
   * 牌桌本身已经把选中的牌抬起来了（`renderHand` 的 `lift`），这里补的是**抬起的过程**；
   * 幽灵牌与实体牌同位同图，收掉之后画面没有任何残留。
   */
  private cueSelectTile(payload: AnimationPayload, add: Add, done: Laya.Handler, duration: number): void {
    const rect = handTileRect(payload.handIndex ?? 0, payload.isDrawn === true);
    const wrap = new Laya.Sprite();
    wrap.size(rect.w + 6, rect.h + 6);
    wrap.pos(rect.x - 3, rect.y - 3);
    wrap.graphics.drawRoundRect(0, 0, rect.w + 6, rect.h + 6, 9, 9, 9, 9, "#00000000", THEME.accent, 3);
    if (payload.tile !== undefined) {
      const image = this.tileImage({ x: 3, y: 3, w: rect.w, h: rect.h }, payload.tile);
      wrap.addChild(image);
    }
    wrap.alpha = 0;
    add(wrap);
    Laya.Tween.to(wrap, { alpha: 1, y: rect.y - SELECT_LIFT }, duration, Laya.Ease.cubicOut);
    Laya.Tween.to(wrap, { alpha: 0 }, duration * 0.9, Laya.Ease.quadIn, done, duration * 1.3);
  }

  /** 摸牌：一张幽灵牌从摸牌位轻滑入落定。不做夸张飞行。 */
  private cueDraw(payload: AnimationPayload, add: Add, done: Laya.Handler, duration: number): void {
    if (payload.tile === undefined) return;
    const rect = handTileRect(payload.handIndex ?? 0, true);
    const ghost = this.tileImage(rect, payload.tile);
    ghost.pos(rect.x + DRAW_SLIDE_IN, rect.y - 6);
    ghost.alpha = 0.35;
    add(ghost);
    Laya.Tween.to(ghost, { x: rect.x, y: rect.y, alpha: 1 }, duration, Laya.Ease.cubicOut, done);
  }

  /**
   * 出牌：从手牌槽位飞向牌河落点 + 轻微缩放回正。
   *
   * 起点与落点都是牌桌渲染同一格用的坐标，因此动画结束的位置**就是**那张牌最终所在格。
   */
  private cueDiscard(payload: AnimationPayload, add: Add, done: Laya.Handler, duration: number): void {
    if (payload.tile === undefined) return;
    const from = handTileRect(payload.handIndex ?? 0);
    const to = riverCellRect(payload.riverIndex ?? 0);
    const ghost = this.tileImage(from, payload.tile);
    ghost.pivot(from.w / 2, from.h / 2);
    ghost.scaleX = DISCARD_SCALE_UP;
    ghost.scaleY = DISCARD_SCALE_UP;
    add(ghost);
    Laya.Tween.to(ghost, { x: to.x + to.w / 2 - from.w / 2, y: to.y, scaleX: 1, scaleY: 1 }, duration, Laya.Ease.cubicOut);
    // 落定前 40ms 开始淡出，让底下那张真牌"接手"，避免看见一次凭空消失。
    Laya.Tween.to(ghost, { alpha: 0 }, 60, Laya.Ease.quadIn, done, Math.max(0, duration - 60));
  }

  /** 最近一手弃牌：金框闪一下。 */
  private cueRiverFlash(payload: AnimationPayload, add: Add, done: Laya.Handler, duration: number): void {
    this.fade(this.outline(riverCellRect(payload.riverIndex ?? 0), THEME.accent, 2), add, done, 0.9, 0, duration);
  }

  /** 碰 / 杠：N 张牌从两侧散开位聚拢到副露位，配一圈金光。杠多一张、亮一档，都不做全屏特效。 */
  private cueMeld(payload: AnimationPayload, count: number, add: Add, done: Laya.Handler, duration: number): void {
    const rect = meldRect(payload.side ?? "bottom");
    const cell = rect.w / 4;
    const gold = this.box({ x: rect.x - 8, y: rect.y - 8, w: rect.w + 16, h: rect.h + 16 }, "#C6A15B22", 12);
    gold.alpha = 0;
    add(gold);
    Laya.Tween.to(gold, { alpha: count === 4 ? 1 : 0.8 }, duration * 0.35, Laya.Ease.cubicOut);
    Laya.Tween.to(gold, { alpha: 0 }, duration * 0.65, Laya.Ease.quadIn);
    for (let index = 0; index < count; index++) {
      const target: Rect = { x: rect.x + index * (cell + 2), y: rect.y, w: cell - 2, h: rect.h };
      const tile = payload.tile === undefined
        ? this.box(target, "#EFE9DA", 4)
        : this.tileImage(target, payload.tile);
      tile.pos(target.x + (index - count / 2) * 46, target.y + 26);
      tile.alpha = 0.35;
      add(tile);
      // 只有最后一张负责收尾：四张同时聚拢，收早了会看见半截。
      const handler = index === count - 1 ? done : null;
      Laya.Tween.to(tile, { x: target.x, y: target.y, alpha: 1 }, duration, Laya.Ease.cubicOut, handler);
    }
  }

  /** 胡：朱红印章落定 + 一圈金色光圈散开。强调一下就完，不做页游式大爆炸。 */
  private cueStamp(payload: AnimationPayload, add: Add, done: Laya.Handler, duration: number): void {
    const center = tableCenter();
    const size = 168;
    const stamp = new Laya.Sprite();
    stamp.size(size, size);
    stamp.pivot(size / 2, size / 2);
    stamp.pos(center.x, center.y);
    stamp.graphics.drawRoundRect(0, 0, size, size, 20, 20, 20, 20, "#00000000", THEME.warn, 7);
    const glyph = this.text(payload.text ?? "胡", 104, THEME.warn);
    glyph.pos(size / 2 - glyph.width / 2, size / 2 - glyph.height / 2);
    stamp.addChild(glyph);
    const halo = this.ring({ x: center.x - size, y: center.y - size, w: size * 2, h: size * 2 }, THEME.accent, 4, 0.31);
    add(halo);
    add(stamp);
    stamp.alpha = 0;
    stamp.scaleX = 0.62;
    stamp.scaleY = 0.62;
    halo.alpha = 0;
    Laya.Tween.to(stamp, { alpha: 1, scaleX: 1, scaleY: 1 }, duration * 0.34, Laya.Ease.backOut);
    Laya.Tween.to(halo, { alpha: 0.7, scaleX: 1.25, scaleY: 1.25 }, duration * 0.5, Laya.Ease.cubicOut);
    Laya.Tween.to(halo, { alpha: 0 }, duration * 0.3, Laya.Ease.quadIn, null, duration * 0.5);
    // 停一下再收：胡牌那一眼要看得清，但不能赖着不走。
    Laya.Tween.to(stamp, { alpha: 0 }, duration * 0.28, Laya.Ease.quadIn, done, 900);
  }

  /** 过：操作位上一条柔和的灰白提示，短到几乎只是一下呼吸。 */
  private cuePass(payload: AnimationPayload, add: Add, done: Laya.Handler, duration: number): void {
    const rect = actionRowRect();
    const pill = this.box({ x: rect.x + rect.w / 2 - 70, y: rect.y + 8, w: 140, h: 46 }, "#F7F4EA22", 23);
    const glyph = this.text(payload.text ?? "过", 30, THEME.ivory);
    glyph.pos(70 - glyph.width / 2, 23 - glyph.height / 2);
    pill.addChild(glyph);
    this.fade(pill, add, done, 0.85, 6, duration);
  }

  /** 操作按钮出现：一条金色下划线轻扫，把视线引过去；不碰按钮本体。 */
  private cueActionButtons(add: Add, done: Laya.Handler, duration: number): void {
    const rect = actionRowRect();
    const bar = this.box({ x: rect.x, y: rect.y + rect.h, w: rect.w, h: 4 }, THEME.accent, 2);
    bar.pivot(rect.w / 2, 2);
    bar.scaleX = 0.2;
    this.fade(bar, add, done, 0.8, 0, duration);
  }

  /** 轮到谁：那一座头像外的金环胀开一下（呼吸环是常态，这是"交给你了"的那一下）。 */
  private cueTurnHighlight(payload: AnimationPayload, add: Add, done: Laya.Handler, duration: number): void {
    const rect = ringRectFor(avatarRect(payload.side ?? "bottom"), 8);
    const ring = this.ring(rect, THEME.accent, 3);
    add(ring);
    Laya.Tween.to(ring, { alpha: 0, scaleX: 1.18, scaleY: 1.18 }, Math.max(duration, 320), Laya.Ease.cubicOut, done);
  }

  private cueDialPulse(add: Add, done: Laya.Handler, duration: number): void {
    const rect = dialRect();
    const ring = this.ring(rect, THEME.warn, 3, 0.34);
    add(ring);
    Laya.Tween.to(ring, { alpha: 0.9, scaleX: 1.1, scaleY: 1.1 }, duration * 0.45, Laya.Ease.cubicOut);
    Laya.Tween.to(ring, { alpha: 0 }, duration * 0.55, Laya.Ease.quadIn, done, duration * 0.45);
  }

  /** 托管 / 接管：用冻结图标提示一下。手牌降饱和由牌桌自身的置灰负责，这里不重复改实体。 */
  private cueTrustee(on: boolean, add: Add, done: Laya.Handler, duration: number): void {
    const center = tableCenter();
    const wrap = new Laya.Sprite();
    wrap.size(460, 150);
    wrap.pos(center.x - 230, center.y - 190);
    const icon = new Laya.Image();
    icon.skin = on ? ANIMATION_ASSET.iconTrustee : ANIMATION_ASSET.iconTakeover;
    icon.size(64, 64);
    icon.pos(230 - 32, 0);
    const hint = this.text(on ? "已交给系统代打" : "已回到你的操作", 28, on ? THEME.accent : THEME.good);
    hint.pos(230 - hint.width / 2, 74);
    wrap.addChild(icon);
    wrap.addChild(hint);
    // 提示要多留一会儿：玩家得看清自己现在是不是在托管，淡出本身不设时长门槛。
    this.fade(wrap, add, done, 1, 10, duration, 1100);
  }

  /**
   * 结算卡片：米白底、金边，轻微上浮淡入。不做整屏遮罩重动画。
   *
   * 大局那一档多一层**少量**淡金粒子与一小串桂叶 —— 固定 8 颗、只位移与淡出，
   * 是预置 Tween，不是实时粒子系统。
   */
  private cueResultCard(payload: AnimationPayload, major: boolean, add: Add, done: Laya.Handler, duration: number): void {
    const center = tableCenter();
    const rect: Rect = { x: center.x - 300, y: center.y - 170, w: 600, h: 280 };
    const card = new Laya.Sprite();
    card.size(rect.w, rect.h);
    card.pos(rect.x, rect.y + 18);
    card.graphics.drawRoundRect(0, 0, rect.w, rect.h, 18, 18, 18, 18, "#F7F4EAF2", THEME.accent, 3);
    const title = this.text(payload.text ?? (major ? "本局结束" : "本小场结束"), major ? 42 : 36, "#3A2A18");
    title.pos(rect.w / 2 - title.width / 2, 44);
    card.addChild(title);
    if (major) {
      const leaf = new Laya.Sprite();
      leaf.graphics.drawRoundRect(rect.w / 2 - 46, 112, 26, 8, 6, 6, 6, 6, THEME.good);
      leaf.graphics.drawRoundRect(rect.w / 2 - 13, 106, 26, 8, 6, 6, 6, 6, THEME.accent);
      leaf.graphics.drawRoundRect(rect.w / 2 + 20, 112, 26, 8, 6, 6, 6, 6, THEME.good);
      card.addChild(leaf);
    }
    if (payload.delta !== undefined) {
      const score = this.text(`${payload.delta >= 0 ? "+" : ""}${payload.delta}`, 34, payload.delta >= 0 ? THEME.good : THEME.bad);
      score.pos(rect.w / 2 - score.width / 2, major ? 146 : 120);
      card.addChild(score);
    }
    card.alpha = 0;
    add(card);
    Laya.Tween.to(card, { alpha: 1, y: rect.y }, duration * 0.6, Laya.Ease.cubicOut);
    Laya.Tween.to(card, { alpha: 0, y: rect.y - 10 }, duration * 0.4, Laya.Ease.quadIn, done, 1300);
    if (major) this.goldDust(rect, add);
  }

  /** 少量淡金粒子：数量固定，只位移与淡出。 */
  private goldDust(rect: Rect, add: Add): void {
    for (let index = 0; index < 8; index++) {
      const size = 6 + (index % 3) * 3;
      const dot = new Laya.Sprite();
      dot.size(size, size);
      dot.pos(rect.x + ((index * 97) % rect.w), rect.y + rect.h * 0.72);
      dot.graphics.drawCircle(size / 2, size / 2, size / 2, THEME.accent);
      dot.alpha = 0.9;
      add(dot);
      Laya.Tween.to(dot, { y: dot.y - 130 - (index % 4) * 26, alpha: 0 }, 900 + index * 60, Laya.Ease.quadOut);
    }
  }

  private cueScoreFloat(payload: AnimationPayload, add: Add, done: Laya.Handler, duration: number): void {
    if (!payload.text) return;
    const center = tableCenter();
    const positive = (payload.delta ?? 0) >= 0;
    const label = this.text(payload.text, 40, positive ? THEME.good : THEME.bad);
    label.pos(center.x - label.width / 2, center.y - 40);
    this.fade(label, add, done, 1, 46, Math.max(duration, 500), 500);
  }

  /** 页面切换：一层不接命中的深色帷幕擦过。它不吃点击，所以哪怕正在放也不挡操作。 */
  private cueScreenTransition(add: Add, done: Laya.Handler, duration: number): void {
    const veil = new Laya.Sprite();
    // 帷幕要盖住**整屏**，而大厅是竖屏、牌桌是横屏，设计尺寸每切一次页就变一回。
    const width = Laya.stage.designWidth || this.overlay.width;
    const height = Laya.stage.designHeight || this.overlay.height;
    veil.size(width, height);
    veil.graphics.drawRect(0, 0, width, height, "#04100A");
    veil.alpha = 0;
    add(veil);
    Laya.Tween.to(veil, { alpha: 0.5 }, duration * 0.35, Laya.Ease.quadIn);
    Laya.Tween.to(veil, { alpha: 0 }, duration * 0.65, Laya.Ease.quadOut, done, duration * 0.35);
  }

  /** 换三张 / 定缺：手牌行上一条金色横扫，表示"这一手在动整排牌"。 */
  private cueHandSweep(add: Add, done: Laya.Handler, duration: number): void {
    const first = handTileRect(0);
    const last = handTileRect(13);
    const band = this.box({ x: first.x, y: first.y - 6, w: last.x + last.w - first.x, h: 4 }, THEME.accent, 2);
    this.fade(band, add, done, 0.75, 8, Math.max(duration, 420));
  }
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
