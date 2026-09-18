// 第二阶段页面（04-10）：继承大厅母版体系。
// 背景分配：04/05/07/08/09 = 大厅背景 + 宣纸纱；06 = 聊天背景；10 = 房间背景（无纱，更亮）。
import { join } from "node:path";
import { writeFileSync } from "node:fs";

const OUT = join(import.meta.dirname, "screens");

const EXT_JS = `<script>
  if (new URLSearchParams(location.search).get("ext") === "1") {
    for (const el of document.querySelectorAll(".js-nick")) el.textContent = "超级超级超级长的玩家昵称测试";
    for (const el of document.querySelectorAll(".js-gname")) el.textContent = "超级超级超级长的群聊名称测试";
    for (const el of document.querySelectorAll(".js-uid")) el.textContent = "1800000001";
    for (const el of document.querySelectorAll(".js-points")) el.textContent = "9999";
    for (const el of document.querySelectorAll(".js-roomno")) el.textContent = "999999";
    for (const el of document.querySelectorAll(".js-delta")) el.textContent = "+9999";
  }
<\/script>`;

const PAPER = `<style>
  .paper-veil { position:absolute; inset:0; background:linear-gradient(155deg, rgba(247,241,227,.50) 0%, rgba(240,232,214,.34) 50%, rgba(240,232,214,.25) 100%); backdrop-filter:blur(5.5px); }
  .lk-heading { display:flex; align-items:center; gap:22px; padding:var(--safe) 60px 0; }
  .lk-heading .panel-title { color:var(--ink); }
  .lk-heading .right-actions { margin-left:auto; display:flex; gap:14px; }
  .lk-btn-jade { display:inline-flex; align-items:center; justify-content:center; height:84px; border:none; cursor:pointer; border-radius:var(--radius-md); background:linear-gradient(180deg,#4A7A62,#3F6B5A 60%,#34594B); color:#F2EBDD; font-size:var(--fs-btn-lg); font-weight:800; letter-spacing:5px; box-shadow:0 6px 0 rgba(34,58,48,.6), 0 14px 28px rgba(60,40,20,.3); }
  .lk-btn-jade.is-disabled { background:var(--disabled-bg); color:var(--disabled-tx); box-shadow:none; pointer-events:none; }
  .keypad .btn { background:rgba(247,241,227,.9); color:var(--ink); border:1px solid rgba(138,109,73,.35); }
</style>`;

const page = (name, body) => `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>${name} · 麻雀精灵</title>
<link rel="stylesheet" href="../tokens.css">${PAPER}</head>
<body class="screen" data-screen="${name}">
${body}
${EXT_JS}
</body></html>`;

const heading = (title, right = "") => `
  <div class="lk-heading"><div class="btn btn-ghost" style="font-size:26px; color:var(--ink);">‹ 返回大厅</div><div class="panel-title">${title}</div>${right}</div>`;
const headingRight = (title, inner) => `
  <div class="lk-heading"><div class="btn btn-ghost" style="font-size:26px; color:var(--ink);">‹ 返回大厅</div><div class="panel-title">${title}</div><div class="right-actions">${inner}</div></div>`;

/* ============ 04 加入房间 ============ */
const key = (k) => {
  const dim = k === "清空" || k === "删除";
  return `<div class="btn btn-secondary" style="width:170px;height:86px;${dim ? "color:var(--tx-3);" : "background:rgba(247,241,227,.9); color:var(--ink); border-color:rgba(138,109,73,.35);"}">${k}</div>`;
};
const p04 = `
  <style>
    /* 04 页内修订：虚化减弱 ~20% + 当前位暖光焦点 */
    .paper-veil { backdrop-filter:blur(4.4px) !important; }
    .otp .cell.cursor { border-color:var(--gold); background:rgba(255,255,255,.5); box-shadow:0 4px 0 rgba(0,0,0,.22), 0 0 0 2px rgba(201,166,96,.4), 0 0 22px rgba(201,166,96,.30); }
  </style>
  <img class="bg-cover" src="../assets/bg-lobby.png">
  <div class="scrim paper-veil"></div>
  ${heading("加 入 房 间")}
  <div class="core" style="justify-content:center; align-items:center;">
    <div style="text-align:center; margin-bottom:24px; color:var(--ink-2); font-size:var(--fs-sub);">请输入 6 位房间号</div>
    <div class="otp" style="margin-bottom:28px;">
      <div class="cell filled">5</div><div class="cell filled">1</div><div class="cell cursor"></div>
      <div class="cell"></div><div class="cell"></div><div class="cell"></div>
    </div>
    <div class="keypad" style="display:grid; grid-template-columns:repeat(3,170px); gap:14px; justify-content:center; margin-bottom:30px;">
      ${["1","2","3","4","5","6","7","8","9","清空","0","删除"].map(key).join("")}
    </div>
    <button class="btn is-disabled" style="min-width:420px; background:linear-gradient(180deg,#4A7A62,#3F6B5A 60%,#34594B);">加 入 房 间</button>
    <div style="margin-top:20px; text-align:center;">
      <div style="font-size:20px; color:var(--neg); opacity:.92;">房间不存在，请检查房间号</div>
      <div style="font-size:var(--fs-mini); color:var(--ink-2); margin-top:8px; opacity:.78;">状态示例（任意时刻仅显示一条，默认不显示、区域自然收起）：房间不存在 / 房间已满 / 该房间已结束 / 网络异常，请重试</div>
    </div>
  </div>`;

/* ============ 05 牌友群列表 ============ */
const groupRow = (gname, gno, last, time, unread, members) => `
  <div class="row" style="justify-content:space-between; padding:24px 16px;">
    <div class="player-info" style="width:560px; color:var(--ink);">
      <div class="avatar" style="width:78px;height:78px;border-radius:16px; box-shadow:inset 0 0 0 2px rgba(201,166,96,.4);">群</div>
      <div style="min-width:0;">
        <div class="nick js-gname">${gname}</div>
        <div class="uid" style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${last}</div>
      </div>
    </div>
    <div style="text-align:center; width:160px;" class="uid"><div class="num">${gno}</div><div>${members} 人</div></div>
    <div style="text-align:right; width:130px;" class="uid"><div>${time}</div>${unread ? `<span class="unread">${unread}</span>` : ""}</div>
  </div>`;
const p05 = `
  <img class="bg-cover" src="../assets/bg-lobby.png">
  <div class="scrim paper-veil"></div>
  ${headingRight("牌 友 群", '<button class="btn btn-sm" style="background:linear-gradient(180deg,#4A7A62,#3F6B5A); color:#F2EBDD; height:58px;">创建群聊</button><button class="btn btn-secondary btn-sm" style="height:58px;">搜索 / 加入</button>')}
  <div style="flex:1; padding:10px 60px 0;">
    ${groupRow("茶馆常客血战局", "10000001", "夜雨声烦: 晚上8点，老位置，来三个", "20:14", 3, 6)}
    ${groupRow("每周四固定局", "10000002", "我 分享了房间邀请 654321", "昨日", 0, 5)}
    ${groupRow("绵阳牌友交流", "10000003", "[图片]", "昨日", 12, 23)}
    ${groupRow("周末家庭场", "10000004", "群主 开启了全员禁言", "09-16", 0, 4)}
    ${groupRow("宽窄巷子小分队", "10000005", "锦城小乖 撤回了一条消息", "09-15", 0, 8)}
  </div>`;

/* ============ 06 群聊（聊天背景；明亮气泡修订版） ============ */
const gcMsg = (nick, inner, time, self) => `
  <div class="msg ${self ? "self" : ""}">
    <div class="avatar" style="width:62px;height:62px;font-size:26px;">${self ? "雀" : nick[0]}</div>
    <div style="min-width:0;">
      <div class="meta">${self ? time : nick + " · " + time}</div>
      <div class="bubble">${inner}</div>
    </div>
  </div>`;
const gcStyle = `<style>
    .gc-side { background:rgba(247,241,227,.95) !important; }
    .gc-side .nick { color:#2E3440 !important; }
    .gc-side .uid, .gc-side .gc-sub { color:#8A8272 !important; }
    .gname-clamp { display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; white-space:normal; }
    .gc-mid { background:rgba(247,241,227,.62) !important; }
    .gc-mid .bubble { background:rgba(250,246,236,.96) !important; color:#3A3428 !important; border:1px solid rgba(138,109,73,.22); box-shadow:0 6px 16px rgba(60,40,20,.14) !important; }
    .gc-mid .msg.self .bubble { background:#DCE9E2 !important; color:#2E3440 !important; }
    .gc-mid .meta, .gc-mid .sysmsg { color:#7A6F5E !important; }
    .gc-right { background:rgba(247,241,227,.93) !important; }
    .gc-right .nick { color:#2E3440 !important; }
    .gc-right .uid { color:#8A8272 !important; }
    .invite-card { background:linear-gradient(180deg,#4A3B2C 0%, #3A2E22 100%) !important; }
    .invite-card .ic-no { color:#F2EBDD !important; }
  </style>`;
const gcGroupRow = (gname, gno, last, time, unread, members) => `
  <div style="display:flex; align-items:center; gap:14px; padding:16px 10px; border-bottom:1px solid rgba(138,109,73,.16); color:var(--ink);">
    <div class="avatar" style="width:70px;height:70px;border-radius:16px; box-shadow:inset 0 0 0 2px rgba(201,166,96,.4); flex:0 0 auto;">群</div>
    <div style="min-width:0; flex:1;">
      <div class="nick js-gname gname-clamp" style="font-size:22px; line-height:1.35;">${gname}</div>
      <div style="font-size:var(--fs-mini); color:#7A6F5E; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:4px;">${last}</div>
    </div>
    <div style="text-align:right; flex:0 0 auto;">
      <div style="font-size:var(--fs-mini); color:#8A8272;">${time}</div>
      ${unread ? '<span class="unread" style="margin-top:6px; display:inline-flex;">' + unread + '</span>' : ''}
      <div style="font-size:var(--fs-mini); color:#8A8272; margin-top:4px;">${members} 人</div>
    </div>
  </div>`;
const p06 = `
  <img class="bg-cover" src="../assets/bg-group.png">
  <div class="scrim" style="background:linear-gradient(180deg, rgba(24,28,26,.30) 0%, rgba(24,28,26,.14) 40%, rgba(24,28,26,.30) 100%);"></div>
  ${gcStyle}
  <div style="position:absolute; inset:0; display:flex; gap:20px; padding:36px 40px 30px;">
    <div class="gc-side" style="width:350px; border-radius:var(--radius-lg); padding:18px 20px; overflow:hidden;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
        <span style="font-weight:700; color:#2E3440; font-size:24px;">牌友群</span>
        <span style="font-size:var(--fs-mini); color:#8A8272;">＋创建 / 搜索</span>
      </div>
      ${gcGroupRow("茶馆常客血战局", "10000001", "夜雨声烦: 晚上8点，老位置，来三个", "20:14", 3, 6)}
      ${gcGroupRow("每周四固定局", "10000002", "我 分享了房间邀请", "昨日", 0, 5)}
      ${gcGroupRow("绵阳牌友交流", "10000003", "[图片]", "昨日", 12, 23)}
    </div>
    <div class="gc-mid" style="flex:1; display:flex; flex-direction:column; min-width:0; border-radius:var(--radius-lg); overflow:hidden;">
      <div style="display:flex; align-items:center; gap:20px; padding:var(--safe) 40px 14px; border-bottom:1px solid rgba(138,109,73,.22);">
        <div class="btn btn-ghost" style="font-size:26px; color:#2E3440;">‹</div>
        <div style="min-width:0;">
          <div class="nick js-gname" style="font-size:26px; color:#2E3440;">茶馆常客血战局</div>
          <div class="uid num" style="font-size:var(--fs-mini); color:#8A8272;">群号 10000001 · 6 人</div>
        </div>
        <span class="badge badge-owner" style="margin-left:6px;">群主</span>
        <div class="btn btn-ghost" style="margin-left:auto; font-size:var(--fs-sub); color:#2E3440;">更多 / 群设置</div>
      </div>
      <div style="flex:1; overflow:hidden; display:flex; flex-direction:column; gap:18px; padding:18px 34px;">
        <div class="sysmsg">锦城小乖 加入群聊</div>
        ${gcMsg("夜雨声烦", "晚上8点，老位置，来三个", "20:11", false)}
        ${gcMsg("夜雨声烦", `
          <div class="invite-card">
            <div class="ic-head"><span style="font-size:26px;">🀄</span><span class="ic-title">麻将房间邀请</span></div>
            <div class="ic-no num js-roomno">654321</div>
            <div class="ic-meta"><span>等待中 · 2/4 人</span><span>创建者：川西刀客</span></div>
            <div class="ic-cta"><button class="btn btn-sm" style="width:100%; height:60px; background:linear-gradient(180deg,#4A7A62,#3F6B5A); color:#F2EBDD;">加入房间</button></div>
          </div>`, "20:12", false)}
        ${gcMsg("川西刀客", "马上到，先吃个饭", "20:13", true)}
        ${gcMsg("锦城小乖", `<div class="voice"><span style="font-size:22px;">▶</span><span class="wave">${[10,18,26,20,12,22,16,8].map((h) => `<i style="height:${h}px;"></i>`).join("")}</span><span class="dur">12"</span></div>`, "20:13", false)}
        <div class="sysmsg">宽窄巷子 分享了 [图片]</div>
      </div>
      <div style="border-top:1px solid rgba(138,109,73,.3); padding:16px 34px; display:flex; align-items:center; gap:14px; background:rgba(247,241,227,.72);">
        <div class="btn btn-secondary btn-sm" style="width:60px; height:58px; padding:0; font-size:22px; background:rgba(250,246,236,.95); color:#3A3428; border-color:rgba(138,109,73,.3);">图</div>
        <div class="btn btn-secondary btn-sm" style="width:60px; height:58px; padding:0; font-size:22px; background:rgba(250,246,236,.95); color:#3A3428; border-color:rgba(138,109,73,.3);">🎤</div>
        <div class="btn btn-secondary btn-sm" style="width:60px; height:58px; padding:0; font-size:22px; background:rgba(250,246,236,.95); color:#3A3428; border-color:rgba(138,109,73,.3);">😊</div>
        <div class="lk-input" style="flex:1; height:58px;">说点什么…</div>
        <button class="btn btn-sm" style="height:58px; background:linear-gradient(180deg,#4A7A62,#3F6B5A); color:#F2EBDD;">发 送</button>
      </div>
    </div>
    <div class="gc-right" style="width:290px; border-radius:var(--radius-lg); padding:18px 20px; overflow:hidden;">
      <div style="font-weight:700; color:#2E3440; font-size:22px; margin-bottom:8px;">群成员 6</div>
      ${["川西刀客|群主", "夜雨声烦|管理员", "锦城小乖|", "宽窄巷子|", "茶馆老板|", "清风徐来|"].map((m) => {
        const [nick, role] = m.split("|");
        return `<div class="member-row">
          <div class="avatar" style="width:50px;height:50px;font-size:20px;">${nick[0]}</div>
          <div style="min-width:0; flex:1;"><div class="nick" style="font-size:20px;">${nick}</div></div>
          ${role ? `<span class="badge ${role === "群主" ? "badge-owner" : "badge-state"}">${role}</span>` : ""}
        </div>`;
      }).join("")}
      <div style="margin-top:14px; font-size:var(--fs-mini); color:#7A6F5E;">公告：每晚 8 点固定局。</div>
    </div>
  </div>`;

/* ============ 07 战绩 ============ */
const matchRow2 = (t, no, rounds, delta, ended) => `
  <div class="row" style="justify-content:space-between; padding:24px 16px;">
    <div style="min-width:280px; color:var(--ink);">
      <div style="font-weight:700;">${t}</div>
      <div class="uid" style="margin-top:4px;">房号 <span class="num">${no}</span>${ended ? ' · <span style="color:var(--orange);">提前结束</span>' : ""}</div>
    </div>
    <div style="width:170px; text-align:center; color:var(--ink);"><div class="uid">已完成</div><div class="num">${rounds}/8 局</div></div>
    <div style="width:200px; text-align:center; color:var(--ink);"><div class="uid">最终积分</div><div class="num" style="font-size:30px;">${delta}</div></div>
    <div class="btn btn-secondary btn-sm" style="height:54px; background:rgba(247,241,227,.92); color:var(--ink); border-color:rgba(138,109,73,.35);">详情</div>
  </div>`;
const p07 = `
  <img class="bg-cover" src="../assets/bg-lobby.png">
  <div class="scrim paper-veil"></div>
  ${heading("战 绩", "")}
  <div style="flex:1; padding:6px 60px 0;">
    ${matchRow2("09-18 01:52", "161852", 8, "-10", false)}
    ${matchRow2("09-18 01:20", "793646", 8, "+14", false)}
    ${matchRow2("09-17 23:36", "999832", 8, "-4", false)}
    ${matchRow2("09-17 22:58", "962784", 2, "+6", true)}
    ${matchRow2("09-17 21:44", "659944", 0, "0", true)}
  </div>
  <div style="margin:0 60px 26px; color:var(--ink-2); font-size:var(--fs-mini);">
    数据来自 /v1/matches（真实历史）；无对局时显示国风空状态「暂无战绩」。积分变化以服务端结算为准。
  </div>`;

/* ============ 08 个人中心 ============ */
const p08 = `
  <img class="bg-cover" src="../assets/bg-lobby.png">
  <div class="scrim paper-veil"></div>
  ${heading("个 人 中 心")}
  <div style="display:flex; gap:70px; flex:1; padding:30px 90px 0;">
    <div style="width:380px; text-align:center;">
      <div class="avatar" style="width:160px;height:160px;font-size:60px; margin:0 auto; box-shadow:0 0 0 4px var(--gold), 0 14px 30px rgba(60,40,20,.3);">雀</div>
      <div class="nick js-nick" style="font-size:32px; margin-top:18px;">小雀儿</div>
      <div class="uid num js-uid" style="margin-top:4px;">ID 1001234567</div>
    </div>
    <div style="flex:1; display:flex; flex-direction:column; gap:10px;">
      <div class="row" style="justify-content:space-between; padding:24px 18px;"><span style="color:var(--ink-2);">账号</span><span style="color:var(--ink);">10 位数字用户 ID · 密码登录已启用</span></div>
      <div class="row" style="justify-content:space-between; padding:24px 18px;"><span style="color:var(--ink-2);">修改密码</span><span class="btn btn-secondary btn-sm" style="height:54px; background:rgba(247,241,227,.92); color:var(--ink); border-color:rgba(138,109,73,.35);">前往修改</span></div>
      <div style="display:flex; flex-direction:column; gap:14px; margin-top:26px;">
        <button class="btn btn-danger btn-sm" style="width:320px;">退出登录</button>
      </div>
      <div style="color:var(--ink-2); font-size:var(--fs-mini); margin-top:10px;">
        修改头像 / 修改昵称：当前接口未提供，暂不显示入口。
      </div>
    </div>
  </div>`;

/* ============ 09 设置 ============ */
const setRow = (icon, name, on, vol) => `
  <div class="row" style="justify-content:space-between; padding:26px 20px;">
    <div style="display:flex; align-items:center; gap:18px; width:300px;">
      <span style="font-size:34px;">${icon}</span><span style="font-size:var(--fs-body); color:var(--ink);">${name}</span>
    </div>
    <div style="display:flex; align-items:center; gap:26px; flex:1; justify-content:flex-end;">
      ${vol ? '<div class="volume"></div><span class="num" style="font-size:var(--fs-sub); color:var(--ink);">62</span>' : ""}
      <div class="btn btn-secondary btn-sm" style="height:52px; padding:0 18px; background:rgba(247,241,227,.92); color:var(--ink); border-color:rgba(138,109,73,.35);">静音</div>
      <div class="switch ${on ? "on" : ""}"></div>
    </div>
  </div>`;
const p09 = `
  <img class="bg-cover" src="../assets/bg-lobby.png">
  <div class="scrim paper-veil"></div>
  ${heading("设 置", "")}
  <div style="padding:10px 120px 0;">
    <div style="background:rgba(247,241,227,.9); border-radius:var(--radius-lg); padding:8px 30px; box-shadow:0 16px 36px rgba(60,40,20,.22);">
      ${setRow("🎵", "音乐 Music", true, true)}
      ${setRow("🔔", "音效 SFX", true, true)}
      ${setRow("🎙️", "语音 Voice", false, false)}
    </div>
    <div style="color:var(--ink-2); font-size:var(--fs-mini); margin:16px 6px 0;">
      三个独立音频通道（Music / SFX / Voice），实现阶段绑定 AudioManager；当前无本地存储，设计占位。
    </div>
    <div style="display:flex; gap:24px; margin-top:34px; align-items:center;">
      <button class="btn btn-danger btn-sm" style="width:300px;">退出登录</button>
      <span style="color:var(--ink-2); font-size:var(--fs-mini);">版本信息 · 设计稿 v1.0</span>
    </div>
  </div>`;

/* ============ 10 房间等待（房间背景，无纱更亮） ============ */
const waitSeat = (pos, joined, i) => {
  const names = ["小雀儿", "夜雨声烦", "锦城小乖", "宽窄巷子"];
  return joined
    ? `<div class="lk-panel" style="width:${pos === "top" ? 400 : 190}px; padding:${pos === "top" || pos === "bottom" ? "18px 24px" : "22px 14px"}; ${pos === "bottom" ? "box-shadow:inset 0 0 0 2px rgba(201,166,96,.5);" : ""} ${pos === "top" || pos === "bottom" ? "" : "text-align:center;"}">
        <div class="player-info" style="width:100%; color:var(--ink);">
          <div class="avatar" style="width:70px;height:70px;font-size:28px;">${["雀","夜","锦","宽"][i]}</div>
          <div style="min-width:0; flex:1; ${pos === "left" || pos === "right" ? "width:100%;" : ""}">
            <div class="nick js-nick" style="font-size:18px;">${names[i]} ${i === 0 ? '<span class="badge badge-owner">房主</span>' : ""}${i === 0 ? ' <span class="badge badge-me">我</span>' : ""}</div>
            <div class="uid num js-uid" style="font-size:16px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">ID 100123456${i}</div>
          </div>
        </div>
        <div style="margin-top:${pos === "left" || pos === "right" ? "10px" : "12px"};"><span class="badge" style="color:#8A6C28; border:1px solid rgba(201,166,96,.55);">已准备</span></div>
      </div>`
    : `<div class="seat-empty" style="width:${pos === "top" || pos === "bottom" ? 400 : 190}px; padding:${pos === "top" || pos === "bottom" ? "14px" : "22px 14px"}; background:rgba(247,241,227,.5); border-color:rgba(138,109,73,.5);">
        <div class="dash-avatar"></div>
        <div style="font-size:var(--fs-mini);">空位 · 邀请好友 ＋</div>
      </div>`;
};
const p10 = `
  <img class="bg-cover" src="../assets/bg-room.png">
  <div style="position:absolute; left:var(--safe); top:var(--safe); right:var(--safe); display:flex; justify-content:space-between; align-items:center;">
    <div class="btn btn-ghost" style="font-size:var(--fs-sub); color:var(--ink);">‹ 返回大厅</div>
    <div class="btn btn-ghost" style="font-size:var(--fs-sub); color:var(--ink);">退出房间</div>
  </div>
  <div style="position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); width:790px; height:470px; border-radius:44px;
    background:radial-gradient(130% 130% at 50% 28%, #33544A 0%, #22382F 66%, #1D332F 100%);
    box-shadow:0 0 0 16px var(--table-rim), 0 0 0 18px rgba(116,87,68,.55), 0 0 0 20px rgba(20,14,8,.22), inset 0 0 0 2px rgba(201,166,96,.45), inset 0 0 110px rgba(0,0,0,.42), 0 30px 70px rgba(60,40,20,.42);
    display:flex; flex-direction:column; align-items:center; justify-content:center; gap:14px;">
    <div style="display:flex; align-items:center; gap:18px;">
      <span style="color:var(--tx-2); font-size:var(--fs-sub);">房间号</span>
      <span class="num js-roomno" style="font-size:64px; font-weight:800; letter-spacing:12px; color:var(--gold-hi); text-shadow:0 3px 12px rgba(0,0,0,.5);">654321</span>
      <div class="btn btn-secondary btn-sm" style="height:52px; background:rgba(247,241,227,.92); color:#2E3440; border-color:rgba(138,109,73,.35);">📋 复制</div>
    </div>
    <div style="display:flex; gap:14px;">
      <span class="badge" style="background:rgba(247,241,227,.88); color:#2E3440;">四川麻将 · 血战到底</span>
      <span class="badge" style="background:rgba(247,241,227,.88); color:#2E3440;">4 人</span>
      <span class="badge" style="background:rgba(247,241,227,.88); color:#2E3440;">8 小局</span>
    </div>
    <button style="min-width:400px; margin-top:8px; height:88px; border:none; cursor:pointer; border-radius:var(--radius-md); background:linear-gradient(180deg,#55876E 0%, #3F6B5A 58%, #34594B 100%); border:1px solid rgba(201,166,96,.55); color:#F2EBDD; font-size:var(--fs-btn-lg); font-weight:800; letter-spacing:6px; box-shadow:0 6px 0 rgba(24,40,32,.6), 0 16px 30px rgba(30,22,10,.35), inset 0 1px 0 rgba(255,255,255,.25);">开 始 游 戏</button>
    <div style="color:var(--tx-2); font-size:var(--fs-mini);">四人到齐后由房主开始 · 其余玩家显示等待状态</div>
  </div>
  <div style="position:absolute; left:50%; top:110px; transform:translateX(-50%);">${waitSeat("top", 1, 1)}</div>
  <div style="position:absolute; left:210px; top:50%; transform:translateY(-50%);">${waitSeat("left", 1, 2)}</div>
  <div style="position:absolute; right:210px; top:50%; transform:translateY(-50%);">${waitSeat("right", 0, 3)}</div>
  <div style="position:absolute; left:50%; bottom:88px; transform:translateX(-50%);">${waitSeat("bottom", 1, 0)}</div>`;

const rendered = [
  ["04-join-room", page("04-join-room", p04)],
  ["05-group-list", page("05-group-list", p05)],
  ["06-group-chat", page("06-group-chat", p06)],
  ["07-matches", page("07-matches", p07)],
  ["08-profile", page("08-profile", p08)],
  ["09-settings", page("09-settings", p09)],
  ["10-room-waiting", page("10-room-waiting", p10)],
];
for (const [name, html] of rendered) writeFileSync(join(OUT, name + ".html"), html);
console.log("二阶段 7 页已生成 →", OUT);
export { rendered };
