/**
 * 生成**占位**音效。
 *
 * 为什么要有这个脚本：本轮没有任何已授权音频素材，也不允许从网络下载，
 * 但音效与动画的**接线**必须能被真机与浏览器验证 —— 没有声音，
 * 「防叠爆」「音量分组」「事件去重」这些都只能靠读代码相信它是对的。
 *
 * 所以这里用纯离线合成（正弦 / 三角 / 白噪声 + 指数衰减）产出一批占位音：
 * - 不是真实麻将录音，也不试图高度相似（那是素材工作，不是表现层工作）；
 * - 不含任何外部素材与依赖，只写 16 位单声道 PCM WAV；
 * - **可重复执行且结果稳定**：没有随机种子以外的不确定性，噪声用固定种子的 LCG，
 *   同样输入永远得到同样的字节。
 *
 * 用法：`node tools/audio/generate-placeholder-sfx.mjs`
 * 产物：`apps/apk/assets/resources/audio/{sfx,ui}/*.wav` + `audio-manifest.json`
 *
 * ⚠️ 产物一律是 `status: "placeholder"`，不得对外描述为最终产品音频。
 * 换成正式素材时：替换文件、把 `AudioManager` 里对应行的 `ready` 保持为 true 即可，
 * 事件名与调用点都不用改。
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT_ROOT = join(ROOT, "apps/apk/assets/resources/audio");
const SAMPLE_RATE = 22050;

/* ------------------------------------------------------------------ *
 * 合成原语
 * ------------------------------------------------------------------ */

/** 固定种子的线性同余伪随机：可复现，比 `Math.random` 适合产出物。 */
function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const TAU = Math.PI * 2;

const OSCILLATORS = {
  sine: (phase) => Math.sin(phase * TAU),
  triangle: (phase) => 4 * Math.abs(phase - Math.floor(phase + 0.5)) - 1,
  square: (phase) => (phase - Math.floor(phase) < 0.5 ? 0.4 : -0.4),
};

/** 在 `buf` 的 `atMs` 处叠一个音。 */
function tone(buf, { at = 0, ms, freq, type = "sine", peak = 0.5, attackMs = 3, decay = 2.2, slideTo = null }) {
  const start = Math.round((at / 1000) * SAMPLE_RATE);
  const length = Math.round((ms / 1000) * SAMPLE_RATE);
  const attack = Math.max(1, Math.round((attackMs / 1000) * SAMPLE_RATE));
  const wave = OSCILLATORS[type] ?? OSCILLATORS.sine;
  let phase = 0;
  for (let i = 0; i < length; i++) {
    const index = start + i;
    if (index >= buf.length) break;
    const progress = i / length;
    // 指数衰减 + 起始几帧的线性攻击：去掉「咔」的爆音，只留触感。
    const envelope = Math.min(1, i / attack) * Math.pow(1 - progress, decay);
    const instant = slideTo === null ? freq : freq + (slideTo - freq) * progress;
    phase += instant / SAMPLE_RATE;
    buf[index] += wave(phase) * envelope * peak;
  }
}

/**
 * 一拍「牌与牌相碰」。
 *
 * 白噪声过一极低通得到木质头音，再叠一点基音撑住音高 —— 比纯噪声柔和，
 * 也比纯正弦更像桌面上那一下。
 */
function strike(buf, { at = 0, ms = 45, freq = 900, peak = 0.5, toneMix = 0.55, seed = 7 }) {
  const start = Math.round((at / 1000) * SAMPLE_RATE);
  const length = Math.round((ms / 1000) * SAMPLE_RATE);
  const random = lcg(seed);
  const mix = (1 - 0.6) ** (SAMPLE_RATE / 4000); // 一极低通：切掉刺耳的高频
  let filtered = 0;
  let phase = 0;
  for (let i = 0; i < length; i++) {
    const index = start + i;
    if (index >= buf.length) break;
    const progress = i / length;
    const envelope = Math.pow(1 - progress, 2.6);
    filtered += ((random() * 2 - 1) - filtered) * (1 - mix);
    phase += freq / SAMPLE_RATE;
    buf[index] += (toneMix * Math.sin(phase * TAU) + (1 - toneMix) * filtered * 1.6) * envelope * peak;
  }
}

/** 首尾各留几帧淡入淡出，避免切片边界本身发出「哒」的一声。 */
function edgeFade(buf, ms = 4) {
  const n = Math.max(1, Math.round((ms / 1000) * SAMPLE_RATE));
  for (let i = 0; i < n; i++) {
    const gain = i / n;
    buf[i] *= gain;
    buf[buf.length - 1 - i] *= gain;
  }
}

/** 归一化到给定峰值后写成 16 位单声道 PCM WAV。 */
function toWav(buf, peakTarget = 0.5) {
  let peak = 0;
  for (const sample of buf) peak = Math.max(peak, Math.abs(sample));
  const gain = peak > 0 ? peakTarget / peak : 0;
  const bytes = Buffer.alloc(44 + buf.length * 2);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(36 + buf.length * 2, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); // PCM
  bytes.writeUInt16LE(1, 22); // 单声道
  bytes.writeUInt32LE(SAMPLE_RATE, 24);
  bytes.writeUInt32LE(SAMPLE_RATE * 2, 28);
  bytes.writeUInt16LE(2, 30);
  bytes.writeUInt16LE(16, 32);
  bytes.write("data", 36);
  bytes.writeUInt32LE(buf.length * 2, 40);
  for (let i = 0; i < buf.length; i++) {
    const value = Math.round(Math.max(-1, Math.min(1, buf[i] * gain)) * 32767);
    bytes.writeInt16LE(value, 44 + i * 2);
  }
  return bytes;
}

function render(durationMs, draw) {
  const buf = new Float64Array(Math.round((durationMs / 1000) * SAMPLE_RATE));
  draw(buf);
  edgeFade(buf);
  return toWav(buf);
}

/* ------------------------------------------------------------------ *
 * 事件表
 *
 * 编排原则（任务书第三节）：短、清晰、不刺耳。
 * - 牌类一律 40~120ms，比一次出牌动作短，绝不拖操作；
 * - 碰 / 杠 / 胡用**更高峰值与更多下数**做层级，不靠拉长；
 * - 提示音（倒计时、轮到你了）落在 700~1200Hz 的人耳敏感区但不加高频锯齿。
 * ------------------------------------------------------------------ */

/** @type {Array<{file: string, group: "sfx"|"ui", ms: number, cue: string, note: string, draw: (buf: Float64Array) => void}>} */
const SOUND_TRACKS = [
  {
    file: "placeholder_tile_draw.wav", group: "sfx", ms: 110, cue: "draw",
    note: "摸牌：轻而短的一下，末尾带上一点滑动，像把牌从桌面前推出来。",
    draw: (buf) => strike(buf, { at: 0, ms: 55, freq: 1050, toneMix: 0.4, seed: 11 }),
  },
  {
    file: "placeholder_tile_select.wav", group: "sfx", ms: 90, cue: "tileSelect",
    note: "选牌：比摸牌更轻、音高略高，只表示「这张被我点起来了」。",
    draw: (buf) => strike(buf, { at: 0, ms: 40, freq: 1320, peak: 0.42, toneMix: 0.6, seed: 13 }),
  },
  {
    file: "placeholder_tile_discard.wav", group: "sfx", ms: 130, cue: "discard",
    note: "出牌：落桌那一下要有木板回声，比选牌重。",
    draw: (buf) => {
      strike(buf, { at: 0, ms: 60, freq: 820, toneMix: 0.5, seed: 17 });
      tone(buf, { at: 8, ms: 70, freq: 300, peak: 0.24, decay: 3 });
    },
  },
  {
    file: "placeholder_peng.wav", group: "sfx", ms: 240, cue: "peng",
    note: "碰：两下相叠（拿牌碰出去），明显重于普通点击。",
    draw: (buf) => {
      strike(buf, { at: 0, ms: 60, freq: 980, toneMix: 0.45, seed: 19 });
      strike(buf, { at: 70, ms: 70, freq: 1240, toneMix: 0.5, seed: 23 });
      tone(buf, { at: 70, ms: 130, freq: 470, peak: 0.3, decay: 2.4 });
    },
  },
  {
    file: "placeholder_gang.wav", group: "sfx", ms: 330, cue: "kong",
    note: "杠：三下递进 + 更低的上限音，比碰强一档但不铺满。",
    draw: (buf) => {
      strike(buf, { at: 0, ms: 55, freq: 900, toneMix: 0.45, seed: 29 });
      strike(buf, { at: 65, ms: 55, freq: 1080, toneMix: 0.45, seed: 31 });
      strike(buf, { at: 130, ms: 85, freq: 1420, toneMix: 0.55, seed: 37 });
      tone(buf, { at: 130, ms: 180, freq: 330, peak: 0.32, decay: 2 });
    },
  },
  {
    file: "placeholder_hu.wav", group: "sfx", ms: 620, cue: "hu",
    note: "胡：先一记重拍，再叠一个上行双音收住 —— 全桌最响的一下，仍然不到一秒。",
    draw: (buf) => {
      strike(buf, { at: 0, ms: 90, freq: 1180, toneMix: 0.5, seed: 41 });
      tone(buf, { at: 40, ms: 260, freq: 587, type: "triangle", peak: 0.36, decay: 1.6 });
      tone(buf, { at: 170, ms: 380, freq: 880, type: "triangle", peak: 0.36, decay: 1.5 });
    },
  },
  {
    file: "placeholder_self_draw.wav", group: "sfx", ms: 560, cue: "self-draw",
    note: "自摸：与胡同一族但收得更紧，尾音高半音，听得出是另一种成就感。",
    draw: (buf) => {
      strike(buf, { at: 0, ms: 70, freq: 1320, toneMix: 0.5, seed: 43 });
      tone(buf, { at: 30, ms: 220, freq: 659, type: "triangle", peak: 0.34, decay: 1.7 });
      tone(buf, { at: 150, ms: 330, freq: 988, type: "triangle", peak: 0.32, decay: 1.6 });
    },
  },
  {
    file: "placeholder_round_finished.wav", group: "sfx", ms: 460, cue: "round-finished",
    note: "小局结算：三音下行，表示「这一小节落了」，不做胜利号角。",
    draw: (buf) => {
      tone(buf, { at: 0, ms: 150, freq: 784, type: "triangle", peak: 0.3, decay: 1.8 });
      tone(buf, { at: 120, ms: 160, freq: 587, type: "triangle", peak: 0.3, decay: 1.8 });
      tone(buf, { at: 250, ms: 200, freq: 440, type: "triangle", peak: 0.3, decay: 1.6 });
    },
  },
  {
    file: "placeholder_match_finished.wav", group: "sfx", ms: 700, cue: "match-finished",
    note: "整场结算：比小局多一层低音托住，正式一档，靠层次不靠响度。",
    draw: (buf) => {
      tone(buf, { at: 0, ms: 200, freq: 523, type: "triangle", peak: 0.28, decay: 1.7 });
      tone(buf, { at: 160, ms: 220, freq: 659, type: "triangle", peak: 0.28, decay: 1.7 });
      tone(buf, { at: 330, ms: 340, freq: 784, type: "triangle", peak: 0.3, decay: 1.4 });
      tone(buf, { at: 330, ms: 340, freq: 262, peak: 0.2, decay: 1.4 });
    },
  },
  {
    file: "placeholder_swap.wav", group: "sfx", ms: 260, cue: "swap",
    note: "换三张：三下极轻的点，像三张牌被推出去。",
    draw: (buf) => {
      strike(buf, { at: 0, ms: 40, freq: 1150, peak: 0.34, toneMix: 0.4, seed: 47 });
      strike(buf, { at: 70, ms: 40, freq: 1250, peak: 0.34, toneMix: 0.4, seed: 53 });
      strike(buf, { at: 140, ms: 45, freq: 1350, peak: 0.34, toneMix: 0.4, seed: 59 });
    },
  },
  {
    file: "placeholder_choose_missing.wav", group: "sfx", ms: 200, cue: "choose-missing",
    note: "定缺：一下落定带短促下坠，表示「这门不要了」。",
    draw: (buf) => {
      strike(buf, { at: 0, ms: 45, freq: 1020, toneMix: 0.45, seed: 61 });
      tone(buf, { at: 30, ms: 140, freq: 620, slideTo: 320, peak: 0.3, decay: 2 });
    },
  },
  {
    file: "placeholder_click.wav", group: "ui", ms: 70, cue: "button",
    note: "通用点击：50ms 的干点，不糊成一片。",
    draw: (buf) => strike(buf, { at: 0, ms: 34, freq: 1500, peak: 0.36, toneMix: 0.65, seed: 67 }),
  },
  {
    file: "placeholder_back.wav", group: "ui", ms: 110, cue: "uiBack",
    note: "返回：比点击低一档并往下滑，语义上就是「退回去」。",
    draw: (buf) => tone(buf, { at: 0, ms: 90, freq: 760, slideTo: 470, peak: 0.34, decay: 2.4 }),
  },
  {
    file: "placeholder_pass.wav", group: "ui", ms: 120, cue: "pass",
    note: "过：闷一下就好，不要有存在感。",
    draw: (buf) => tone(buf, { at: 0, ms: 80, freq: 300, type: "triangle", peak: 0.3, decay: 3 }),
  },
  {
    file: "placeholder_turn_notify.wav", group: "ui", ms: 260, cue: "turnNotify",
    note: "轮到你了：两声上行轻提示，要能从桌面环境声里出来，但不催。",
    draw: (buf) => {
      tone(buf, { at: 0, ms: 110, freq: 880, type: "triangle", peak: 0.3, decay: 2 });
      tone(buf, { at: 110, ms: 130, freq: 1175, type: "triangle", peak: 0.3, decay: 2 });
    },
  },
  {
    file: "placeholder_countdown.wav", group: "ui", ms: 120, cue: "countdown-3",
    note: "倒计时（10 秒内每秒）：中音单点，稳定不抢戏。",
    draw: (buf) => tone(buf, { at: 0, ms: 70, freq: 700, peak: 0.3, decay: 3 }),
  },
  {
    file: "placeholder_countdown_fast.wav", group: "ui", ms: 130, cue: "countdown-1",
    note: "倒计时（最后 1 秒）：高一点、硬一点，一眼（一听）就知道要超时了。",
    draw: (buf) => tone(buf, { at: 0, ms: 90, freq: 1180, type: "square", peak: 0.28, decay: 2.4 }),
  },
  {
    file: "placeholder_trustee_on.wav", group: "ui", ms: 300, cue: "trustee",
    note: "托管：两声下行，表示「交出去了」。",
    draw: (buf) => {
      tone(buf, { at: 0, ms: 120, freq: 620, type: "triangle", peak: 0.3, decay: 2 });
      tone(buf, { at: 120, ms: 150, freq: 440, type: "triangle", peak: 0.3, decay: 2 });
    },
  },
  {
    file: "placeholder_trustee_off.wav", group: "ui", ms: 300, cue: "takeover",
    note: "接管：与托管同一对音但反过来（上行），成对记忆。",
    draw: (buf) => {
      tone(buf, { at: 0, ms: 120, freq: 440, type: "triangle", peak: 0.3, decay: 2 });
      tone(buf, { at: 120, ms: 150, freq: 620, type: "triangle", peak: 0.3, decay: 2 });
    },
  },
  {
    file: "placeholder_message.wav", group: "ui", ms: 240, cue: "messageReceive",
    note: "收到消息：柔和的双音，音量组是 UI，不与牌桌音效抢。",
    draw: (buf) => {
      tone(buf, { at: 0, ms: 100, freq: 996, peak: 0.26, decay: 2.2 });
      tone(buf, { at: 90, ms: 130, freq: 1335, peak: 0.24, decay: 2.2 });
    },
  },
];

/* ------------------------------------------------------------------ *
 * 落盘
 * ------------------------------------------------------------------ */

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function build() {
  const manifest = {
    status: "placeholder",
    generatedBy: "tools/audio/generate-placeholder-sfx.mjs",
    sampleRate: SAMPLE_RATE,
    channels: 1,
    bitDepth: 16,
    notice: "离线合成的占位音效，用于验证表现层接线；不代表最终产品音质，也不是真实麻将录音。",
    bgm: {
      status: "asset-pending",
      note: "仓库内没有任何已授权背景音乐，AudioManager 的三档场景音乐（lobby / waitingRoom / game）已接好但不会发起请求。",
    },
    voice: {
      status: "runtime-only",
      note: "语音只有玩家运行时录音；报牌语音（喊碰/杠/胡）需要真人素材与授权，当前一律不播。",
    },
    sounds: [],
  };

  for (const track of SOUND_TRACKS) {
    const directory = join(OUT_ROOT, track.group);
    mkdirSync(directory, { recursive: true });
    const bytes = render(track.ms, track.draw);
    const path = join(directory, track.file);
    writeFileSync(path, bytes);
    manifest.sounds.push({
      file: relative(join(ROOT, "apps/apk/assets"), path).replace(/\\/g, "/"),
      cue: track.cue,
      group: track.group,
      status: "placeholder",
      durationMs: track.ms,
      sha256: sha256(bytes),
      note: track.note,
    });
  }

  writeFileSync(join(OUT_ROOT, "audio-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

const manifest = build();
const existing = readdirSync(join(OUT_ROOT, "sfx")).length;
console.log(`占位音效 ${manifest.sounds.length} 条 → apps/apk/assets/resources/audio（sfx 目录 ${existing} 个文件）`);
console.log("状态：placeholder（非最终产品音频）");
