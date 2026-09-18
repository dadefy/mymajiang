// 麻雀精灵 · 最终视觉基准（v4）三页生成器：01 登录 / 02 大厅 / 03 创建房间。
// 背景层 = 4 张参考图素材（assets/，cover 铺满）；UI 层 = 动态元素（玩家/积分/功能卡/导航/按钮）。
// 运行：node build-final.mjs → ./screens/*.html（?ext=1 切极端文本）
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(import.meta.dirname, "screens");
mkdirSync(OUT, { recursive: true });

const EXT_JS = `<script>
  if (new URLSearchParams(location.search).get("ext") === "1") {
    for (const el of document.querySelectorAll(".js-nick")) el.textContent = "超级超级超级长的玩家昵称测试";
    for (const el of document.querySelectorAll(".js-uid")) el.textContent = "1800000001";
    for (const el of document.querySelectorAll(".js-points")) el.textContent = "99999";
    for (const el of document.querySelectorAll(".js-roomno")) el.textContent = "999999";
  }
<\/script>`;

function page(name, body) {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>${name} · 麻雀精灵</title>
<link rel="stylesheet" href="../tokens.css">
<style>
  /* 最终基准 UI 层（背景图之上） */
  .bg-cover { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; }
  .scrim { position:absolute; inset:0; pointer-events:none; }

  /* 玩家信息卡（左上） */
  .player-tag {
    position:absolute; display:flex; align-items:center; gap:16px;
    background:linear-gradient(180deg, rgba(26,38,33,.95), rgba(20,30,26,.93));
    border-radius:999px; padding:10px 26px 10px 12px;
    box-shadow:inset 0 0 0 2px rgba(201,166,96,.55), 0 10px 24px rgba(0,0,0,.35);
  }
  .player-tag .avatar { width:78px; height:78px; border:3px solid var(--gold); font-size:32px; }
  .player-tag .nick { color:#F2EBDD; font-size:26px; font-weight:700; }
  .player-tag .uid { color:rgba(242,235,221,.75); font-size:var(--fs-mini); }
  .lv-badge { display:inline-flex; flex-direction:column; gap:4px; margin-left:6px; }
  .lv-badge .lv { font-size:var(--fs-mini); font-weight:800; color:var(--gold-hi); letter-spacing:1px; }
  .lv-badge .bar { width:120px; height:10px; border-radius:999px; background:rgba(0,0,0,.45); box-shadow:inset 0 0 0 1px rgba(201,166,96,.6); overflow:hidden; }
  .lv-badge .bar i { display:block; height:100%; width:68%; background:linear-gradient(90deg, var(--gold-deep,#A88742), var(--gold-hi)); }

  /* 右上：金币 + 图标钮 */
  .coin-pill {
    position:absolute; display:flex; align-items:center; gap:10px;
    background:linear-gradient(180deg, rgba(26,38,33,.95), rgba(20,30,26,.93));
    border-radius:999px; padding:10px 24px;
    box-shadow:inset 0 0 0 2px rgba(201,166,96,.55), 0 10px 24px rgba(0,0,0,.35);
    color:var(--gold-hi); font-size:28px; font-weight:800;
  }
  .icon-round {
    position:absolute; width:64px; height:64px; border-radius:50%;
    background:linear-gradient(180deg, rgba(26,38,33,.95), rgba(20,30,26,.93));
    box-shadow:inset 0 0 0 2px rgba(201,166,96,.55), 0 8px 18px rgba(0,0,0,.35);
    display:flex; align-items:center; justify-content:center; font-size:28px; color:#F2EBDD; cursor:pointer;
  }

  /* 功能大卡（贴参考图：上图形区 + 下米白文字区 + 右下圆箭头） */
  .fc2 {
    position:relative; width:352px; border-radius:22px; overflow:hidden; cursor:pointer;
    background:var(--ivory-card);
    box-shadow:0 18px 40px rgba(50,35,15,.38), inset 0 0 0 2px rgba(255,255,255,.6);
    transition:transform .1s, filter .1s;
  }
  .fc2:hover { transform:translateY(-8px); filter:brightness(1.05); }
  .fc2:active { transform:translateY(-3px); }
  .fc2 .art { height:300px; position:relative; display:flex; align-items:center; justify-content:center; }
  .fc2 .tile {
    width:124px; height:162px; border-radius:16px;
    background:linear-gradient(180deg, #F7F1E3, #E6DCC4);
    box-shadow:0 10px 0 rgba(0,0,0,.22), 0 22px 36px rgba(0,0,0,.32), inset 0 2px 0 rgba(255,255,255,.8);
    display:flex; align-items:center; justify-content:center;
    font-size:76px; font-weight:800; color:#35544a;
    transform:rotate(-4deg);
  }
  .fc2 .leaf { position:absolute; border-radius:0 60% 0 60%; opacity:.85; }
  .fc2 .felt { position:absolute; border-radius:50%; box-shadow:inset 0 0 60px rgba(0,0,0,.35); }
  .fc2 .bubble { background:#F5F1E6; border-radius:18px; padding:18px 22px; position:relative; box-shadow:0 10px 24px rgba(0,0,0,.25); }
  .fc2 .bubble::after { content:""; position:absolute; left:26px; bottom:-10px; border:12px solid transparent; border-top-color:#F5F1E6; }
  .fc2 .bubble .dots { display:flex; gap:8px; }
  .fc2 .bubble .dots i { width:12px; height:12px; border-radius:50%; }
  .fc2 .txt { padding:20px 26px 26px; position:relative; }
  .fc2 .txt .t { font-size:32px; font-weight:800; letter-spacing:3px; padding-right:96px; }
  .fc2 .txt .s { font-size:var(--fs-mini); color:#8A8272; margin-top:7px; letter-spacing:1px; padding-right:96px; }
  .fc2 .arrow {
    position:absolute; right:16px; top:50%; transform:translateY(-50%); width:54px; height:54px; border-radius:50%;
    display:flex; align-items:center; justify-content:center; color:#fff; font-size:26px;
    box-shadow:0 5px 12px rgba(0,0,0,.28);
  }
  .fc2.f-create .art { background:linear-gradient(180deg,#4A7A62 0%, #2E5044 100%); }
  .fc2.f-create .t { color:#2E5044; }
  .fc2.f-create .arrow { background:#3F6B5A; }
  .fc2.f-join .art { background:linear-gradient(180deg,#C96A50 0%, #A8523F 100%); }
  .fc2.f-join .t { color:#A8523F; }
  .fc2.f-join .arrow { background:#C96A50; }
  .fc2.f-group .art { background:linear-gradient(180deg,#5B7A8C 0%, #46606F 100%); }
  .fc2.f-group .t { color:#46606F; }
  .fc2.f-group .arrow { background:#5B7A8C; }

  /* 底部导航条（半透明深绿，贴参考图） */
  .bottom-bar {
    position:absolute; left:0; right:0; bottom:0; height:128px; padding-bottom:30px;
    background:linear-gradient(180deg, rgba(24,34,30,.88), rgba(14,22,18,.95));
    display:flex; align-items:center; justify-content:center; gap:120px;
  }
  .bottom-bar .bi { display:flex; flex-direction:column; align-items:center; gap:4px; color:#E9E2D2; font-size:var(--fs-mini); cursor:pointer; }
  .bottom-bar .bi .e { font-size:30px; }
  .bottom-bar .bi:hover { color:#fff; }
  .wm { position:absolute; right:34px; bottom:34px; color:rgba(233,226,210,.5); font-size:var(--fs-mini); letter-spacing:3px; }

  /* 品牌 Logo（大厅顶部中央，UI 层文字版） */
  .brand-lobby { position:absolute; left:50%; top:36px; transform:translateX(-50%); text-align:center; }
  .brand-lobby .b1 {
    font-size:64px; font-weight:800; letter-spacing:10px; color:#3A3428;
    font-family:"STKaiti","KaiTi","PingFang SC",serif;
    text-shadow:0 2px 0 rgba(255,255,255,.5), 0 8px 20px rgba(60,40,20,.25);
    display:inline-flex; align-items:flex-start; gap:10px;
  }
  .brand-lobby .seal {
    width:44px; height:44px; border-radius:8px; background:var(--vermilion);
    color:#F7F1E3; font-size:20px; line-height:1.15; display:flex; align-items:center; justify-content:center;
    writing-mode:vertical-rl; font-weight:700; margin-top:6px; box-shadow:0 4px 10px rgba(0,0,0,.25);
  }
  .brand-lobby .b2 {
    display:flex; align-items:center; gap:16px; margin-top:10px; justify-content:center;
    color:#7A6C4E; font-size:var(--fs-sub); letter-spacing:5px;
  }
  .brand-lobby .b2 i { display:block; width:150px; height:1px; background:rgba(138,109,73,.55); }

  /* 二级页（创建房间） */
  .lk-dim-warm { position:absolute; inset:0; background:linear-gradient(180deg, rgba(58,44,26,.44), rgba(44,34,18,.52)); }
</style></head>
<body class="screen" data-screen="${name}">
${body}
${EXT_JS}
</body></html>`;
}

/* ---------- 二次元少女（原创 Q 版，贴参考图气质：棕长发 + 绿白汉元素裙 + 手持"發"牌） ---------- */
const girlSVG = `
  <svg width="520" height="760" viewBox="0 0 360 520" style="overflow:visible;">
    <ellipse cx="180" cy="500" rx="120" ry="18" fill="rgba(60,40,20,.30)"/>
    <path d="M180 34 Q48 58 58 240 Q64 360 96 470 L264 470 Q296 360 302 240 Q312 58 180 34 Z" fill="#4A3826"/>
    <path d="M60 200 Q40 330 66 452 L110 470 Q76 340 88 220 Z" fill="#42311F"/>
    <path d="M300 200 Q320 330 294 452 L250 470 Q284 340 272 220 Z" fill="#42311F"/>
    <ellipse cx="180" cy="152" rx="64" ry="60" fill="#F9E2CC"/>
    <path d="M116 118 Q180 76 244 118 Q232 92 180 88 Q128 92 116 118 Z" fill="#4A3826"/>
    <path d="M242 114 Q268 130 258 158 Q246 136 232 128 Z" fill="#4A3826"/>
    <g transform="translate(252 52) scale(.42)">
      <ellipse cx="100" cy="150" rx="70" ry="74" fill="#F2EBDD"/>
      <circle cx="100" cy="88" r="56" fill="#F2EBDD"/>
      <circle cx="82" cy="86" r="7" fill="#2A2622"/><circle cx="118" cy="86" r="7" fill="#2A2622"/>
      <path d="M95 99 L105 99 L100 108 Z" fill="#C9A660"/>
    </g>
    <ellipse cx="146" cy="158" rx="13" ry="17" fill="#4A3826"/>
    <ellipse cx="196" cy="158" rx="13" ry="17" fill="#4A3826"/>
    <circle cx="149" cy="152" r="4.5" fill="#fff"/><circle cx="199" cy="152" r="4.5" fill="#fff"/>
    <ellipse cx="126" cy="180" rx="9" ry="5" fill="rgba(217,120,103,.3)"/>
    <ellipse cx="216" cy="180" rx="9" ry="5" fill="rgba(217,120,103,.3)"/>
    <path d="M164 186 Q180 200 196 186 Q180 210 164 186 Z" fill="#B85A4A"/>
    <path d="M108 216 Q180 190 252 216 L262 260 Q180 236 98 260 Z" fill="#F2EBDD"/>
    <path d="M98 260 Q180 236 262 260 L266 300 Q180 276 94 300 Z" fill="#3F6B5A"/>
    <path d="M112 300 Q180 282 248 300 L252 348 Q180 330 108 348 Z" fill="#F2EBDD"/>
    <rect x="118" y="352" width="124" height="22" rx="11" fill="#C9A660"/>
    <path d="M96 330 Q60 420 88 486 L140 470 Q104 400 126 352 Z" fill="#F2EBDD"/>
    <g transform="rotate(8 300 260)">
      <rect x="272" y="216" width="64" height="86" rx="10" fill="#F7F1E3" stroke="rgba(0,0,0,.22)"/>
      <rect x="272" y="216" width="64" height="86" rx="10" fill="rgba(63,107,90,.12)"/>
      <text x="304" y="272" font-size="42" text-anchor="middle" fill="#35544a" font-weight="800">發</text>
    </g>
    <path d="M116 374 Q180 400 244 374 L256 470 Q180 496 104 470 Z" fill="#3F6B5A"/>
    <path d="M116 374 Q180 400 244 374" stroke="#F2EBDD" stroke-width="6" fill="none"/>
  </svg>`;

/* ============ 01 登录（红枫湖景背景） ============ */
const p01 = `
  <img class="bg-cover" src="../assets/bg-login.png">
  <div class="scrim" style="background:linear-gradient(180deg, rgba(30,25,15,.10) 0%, rgba(30,25,15,.05) 45%, rgba(30,25,15,.22) 100%);"></div>
  <div style="position:absolute; left:150px; top:210px;">
    <div style="font-size:100px; font-weight:800; letter-spacing:20px; color:var(--ink); font-family:'STKaiti','KaiTi','PingFang SC',serif; text-shadow:0 2px 0 rgba(255,255,255,.55), 0 16px 34px rgba(60,40,20,.3);">麻雀<span style="color:#8A6C28;">精灵</span></div>
    <div style="display:flex; align-items:center; gap:16px; margin-top:18px;">
      <i style="display:block; width:170px; height:1px; background:rgba(138,109,73,.6);"></i>
      <div style="font-size:var(--fs-body); letter-spacing:7px; color:var(--ink-2);">一桌好牌 · 一群好友</div>
      <i style="display:block; width:170px; height:1px; background:rgba(138,109,73,.6);"></i>
    </div>
  </div>
  <div class="lk-panel" style="position:absolute; right:170px; top:50%; transform:translateY(-50%); width:520px; padding:44px 54px 46px;">
    <div class="lk-title">账号登录</div>
    <div class="lk-sub" style="margin:6px 0 24px;">10 位数字用户 ID + 密码</div>
    <div style="display:flex; flex-direction:column; gap:16px;">
      <div class="lk-input num js-uid">1234567890</div>
      <div class="lk-input">••••••••</div>
      <button style="width:100%; margin-top:8px; height:84px; border:none; cursor:pointer; border-radius:var(--radius-md); background:linear-gradient(180deg,#4A7A62,#3F6B5A 60%,#34594B); color:#F2EBDD; font-size:var(--fs-btn-lg); font-weight:800; letter-spacing:6px; box-shadow:0 6px 0 rgba(34,58,48,.6), 0 14px 28px rgba(60,40,20,.3);">进 入 游 戏</button>
      <div style="display:flex; justify-content:space-between;">
        <span style="font-size:var(--fs-sub); color:var(--ink-2);">使用邀请密钥登录</span>
        <span style="font-size:var(--fs-sub); color:var(--ink-2);">忘记密码</span>
      </div>
    </div>
    <div style="display:flex; gap:14px; margin-top:30px;">
      <div style="flex:1; background:rgba(255,255,255,.65); border-radius:var(--radius-sm); padding:12px 14px;">
        <div style="font-size:var(--fs-mini); color:var(--ink-2); margin-bottom:8px;">登录中</div>
        <div style="height:50px; border-radius:var(--radius-sm); background:rgba(63,107,90,.25); display:flex; align-items:center; justify-content:center;"><span class="spinner" style="border-color:rgba(63,107,90,.25); border-top-color:#3F6B5A;"></span></div>
      </div>
      <div style="flex:1; background:rgba(255,255,255,.65); border-radius:var(--radius-sm); padding:12px 14px;">
        <div style="font-size:var(--fs-mini); color:var(--ink-2); margin-bottom:8px;">登录失败</div>
        <div style="font-size:18px; color:var(--neg);">用户 ID 或密码不正确</div>
      </div>
      <div style="flex:1; background:rgba(255,255,255,.65); border-radius:var(--radius-sm); padding:12px 14px;">
        <div style="font-size:var(--fs-mini); color:var(--ink-2); margin-bottom:8px;">网络断开</div>
        <div style="font-size:18px; color:var(--neg);">无法连接服务器</div>
      </div>
    </div>
  </div>
  <div class="sprite-wrap" style="left:110px; bottom:110px; transform:scale(.72); transform-origin:bottom left;">
    <div class="sprite-shadow" style="width:120px; height:18px; bottom:-6px;"></div>
    <svg width="186" height="226" viewBox="0 0 200 240" style="overflow:visible;">
      <ellipse cx="100" cy="150" rx="70" ry="74" fill="#F2EBDD"/>
      <circle cx="100" cy="88" r="56" fill="#F2EBDD"/>
      <path d="M92 34 Q100 16 112 32" stroke="#C9A660" stroke-width="6" fill="none" stroke-linecap="round"/>
      <ellipse cx="100" cy="166" rx="44" ry="44" fill="#E5DCC8"/>
      <circle cx="82" cy="86" r="7" fill="#2A2622"/><circle cx="118" cy="86" r="7" fill="#2A2622"/>
      <circle cx="84.5" cy="83.5" r="2.4" fill="#fff"/><circle cx="120.5" cy="83.5" r="2.4" fill="#fff"/>
      <path d="M95 99 L105 99 L100 108 Z" fill="#C9A660"/>
      <g transform="rotate(-12 158 152)">
        <rect x="136" y="118" width="46" height="64" rx="9" fill="#EFE8D6" stroke="rgba(0,0,0,.22)"/>
        <text x="159" y="162" font-size="32" text-anchor="middle" fill="#35544a" font-weight="700">🀄</text>
      </g>
    </svg>
  </div>`;

/* ============ 02 一级大厅（v4.1：正式背景图 + 独立 UI 层） ============ */
const p02 = `
  <img class="bg-cover" src="../assets/bg-lobby.png">
  <div class="scrim" style="background:linear-gradient(180deg, rgba(20,26,22,.16) 0%, rgba(20,26,22,0) 32%, rgba(16,24,20,.26) 100%);"></div>
  <div class="brand-lobby">
    <div class="b1">麻雀精灵<span class="seal">棋牌</span></div>
    <div class="b2"><i></i>一桌好牌 · 一群好友<i></i></div>
  </div>
  <div class="player-tag" style="left:40px; top:120px;">
    <div class="avatar">雀</div>
    <div style="min-width:0;">
      <div class="nick js-nick">小雀儿</div>
      <div class="uid num js-uid">ID 1001234567</div>
    </div>
  </div>
  <div class="coin-pill" style="left:1290px; top:40px;"><span class="net"><span class="dot"></span><span style="color:#F2EBDD; font-size:var(--fs-sub);">已连接</span></span></div>
  <div class="icon-round" style="left:1512px; top:38px;">✉️</div>
  <div class="icon-round" style="left:1600px; top:38px;">⚙️</div>
  <div style="position:absolute; left:706px; top:340px; display:flex; gap:30px;">
    <div class="fc2 f-create">
      <div class="art"><div class="leaf" style="left:-28px; top:26px; width:150px; height:220px; background:rgba(242,235,221,.14); transform:rotate(24deg);"></div><div class="leaf" style="right:-18px; bottom:36px; width:130px; height:190px; background:rgba(242,235,221,.10); transform:rotate(-30deg);"></div><div class="tile">發</div></div>
      <div class="txt"><div class="t">创建房间</div><div class="s">自定规则 · 邀请好友</div></div>
      <div class="arrow">›</div>
    </div>
    <div class="fc2 f-join">
      <div class="art"><div class="felt" style="width:260px; height:150px; background:radial-gradient(120% 120% at 50% 40%, #4A7A62, #2E5044); box-shadow:0 0 0 8px #5B4333, inset 0 0 40px rgba(0,0,0,.4);"></div><div class="tile" style="transform:rotate(6deg); color:#B85A4A;">中</div></div>
      <div class="txt"><div class="t">加入房间</div><div class="s">输入房号 · 快速开局</div></div>
      <div class="arrow">›</div>
    </div>
    <div class="fc2 f-group">
      <div class="art" style="flex-direction:column; gap:16px;"><div class="bubble"><div class="dots"><i style="background:#5B7A8C;"></i><i style="background:#C9A660;"></i><i style="background:#D97867;"></i></div></div><div style="font-size:30px; opacity:.9;">🌸</div></div>
      <div class="txt"><div class="t">牌友群</div><div class="s">聊天交友 · 约局组队</div></div>
      <div class="arrow">›</div>
    </div>
  </div>
  <div class="bottom-bar">
    <div class="bi"><span class="e">🏆</span><span>战绩</span></div>
    <div class="bi"><span class="e">💬</span><span>群聊</span></div>
    <div class="bi"><span class="e">👤</span><span>个人中心</span></div>
    <div class="bi"><span class="e">⚙️</span><span>设置</span></div>
    <div class="wm">～好牌 · 好友 · 好时光～</div>
  </div>
`;
/* ============ 03 创建房间（二级页） ============ */
const p03 = `
  <img class="bg-cover" src="../assets/bg-lobby.png">
  <div class="scrim" style="background:linear-gradient(155deg, rgba(247,241,227,.50) 0%, rgba(240,232,214,.34) 50%, rgba(240,232,214,.25) 100%); backdrop-filter:blur(5.5px);"></div>
  <div class="scrim" style="background:linear-gradient(180deg, rgba(247,241,227,.85) 0%, rgba(247,241,227,0) 22%);"></div>
  <div style="position:absolute; inset:0;">
    <div style="display:flex; align-items:center; gap:22px; padding:var(--safe) 60px 0;">
      <div class="btn btn-ghost" style="font-size:26px; color:var(--ink);">‹ 返回大厅</div>
      <div class="panel-title" style="color:var(--ink); text-shadow:0 1px 0 rgba(255,255,255,.5);">创 建 房 间</div>
    </div>
    <div style="display:flex; gap:70px; padding:60px 70px 0; align-items:flex-start;">
      <div class="lk-sidenav">
        <div class="si active">玩 法</div>
        <div class="si">人 数</div>
        <div class="si">局 数</div>
        <div class="si">房间规则</div>
      </div>
      <div style="flex:1; display:flex; justify-content:center; padding-top:8px;">
        <div class="lk-rulecard selected">
          <div style="display:flex; align-items:center; gap:22px;">
            <span style="font-size:60px;">🀄</span>
            <div>
              <div style="font-size:40px; font-weight:800; letter-spacing:4px;">四川麻将</div>
              <div style="color:#8A6C28; font-size:var(--fs-body); letter-spacing:3px; margin-top:4px;">血战到底</div>
            </div>
          </div>
          <div style="height:1px; background:rgba(138,109,73,.2); margin:16px 0;"></div>
          <div class="rc-line"><span class="rc-k">人数</span><span class="rc-v num">4 人</span></div>
          <div class="rc-line"><span class="rc-k">局数</span><span class="rc-v num">8 小局 = 1 大局</span></div>
          <div style="color:var(--ink-2); font-size:var(--fs-sub); padding-top:10px;">当前版本规则固定，暂无可配置项。</div>
        </div>
      </div>
    </div>
    <div style="position:absolute; right:80px; bottom:70px; display:flex; flex-direction:column; align-items:center; gap:8px;">
      <button style="min-width:440px; height:96px; border:none; cursor:pointer; border-radius:var(--radius-md); background:linear-gradient(180deg,#4A7A62,#3F6B5A 60%,#34594B); color:#F2EBDD; font-size:36px; font-weight:800; letter-spacing:8px; box-shadow:0 6px 0 rgba(34,58,48,.6), 0 16px 32px rgba(60,40,20,.32);">创 建 房 间</button>
      <div style="color:var(--ink); font-size:var(--fs-mini); opacity:.85;">创建后生成 6 位房号，邀请牌友加入</div>
    </div>
  </div>`;

/* ============ 生成 ============ */
import { rendered as pages2 } from "./build-final-pages2.mjs";
const pages = [["01-login", p01], ["02-lobby", p02], ["03-create-room", p03], ...pages2];
for (const [name, body] of pages) writeFileSync(join(OUT, `${name}.html`), page(name, body));
console.log("最终基准三页已生成 →", OUT);
