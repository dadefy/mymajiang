// 从 Wikimedia Commons 经 weserv 图片代理下载麻将牌面
// 源文件（CC BY-SA 4.0，作者 碧海风，2026-09-16 抽查 0101一萬 / 0301一條 两张确认）：
//   https://commons.wikimedia.org/wiki/File:0101一萬.svg … 0109九萬
//   https://commons.wikimedia.org/wiki/File:0201一餅.svg … 0209九餅
//   https://commons.wikimedia.org/wiki/File:0301一條.svg … 0309九條
// 授权义务：分发时必须署名（App 关于/致谢页 + docs/ASSETS.md），图片本身继续按 CC BY-SA 4.0 授权。
// 输出: <outDir>/{wan|tong|tiao}_{1..9}.png（w=240，等比缩放，透明底）
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// [我们的花色名, Commons 文件名花色码, 中文点数, 中文花色字]
const SUITS = [
  ["wan", "01", "萬"],
  ["tong", "02", "餅"],
  ["tiao", "03", "條"],
];
const RANKS = ["一", "二", "三", "四", "五", "六", "七", "八", "九"];

const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: node fetch-tiles.mjs <outDir>");
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

async function fetchTile(ourName, commonsName) {
  // 直接构造 Commons 缩略图 CDN 直链（250px，API imageinfo 同款规则）：
  // md5(文件名) 的首字符 / 前两字符作为目录，绕开 Special:FilePath 这个对代理 IP 限流很严的 wiki 路由。
  // md5 必须对完整文件名（含 .svg 扩展名）计算，这是 Commons 的路径规则
  const hash = crypto.createHash("md5").update(`${commonsName}.svg`).digest("hex");
  const encoded = encodeURIComponent(`${commonsName}.svg`);
  const proxied = `thumb.wikimedia.org/wikipedia/commons/thumb/${hash[0]}/${hash.slice(0, 2)}/${encoded}/250px-${encoded}.png`;
  const url = `https://images.weserv.nl/?url=${encodeURIComponent(proxied)}`;
  // CDN 偶发抖动时退避重试
  const delays = [0, 1500, 4000, 8000, 15000];
  let lastError = "";
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt] > 0) await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) {
        lastError = `HTTP ${response.status}: ${(await response.text()).slice(0, 120)}`;
        continue;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      const magic = bytes.subarray(0, 4).toString("hex");
      if (magic !== "89504e47") {
        lastError = `非 PNG 内容 (${magic})`;
        continue;
      }
      fs.writeFileSync(path.join(outDir, `${ourName}.png`), bytes);
      return `OK   ${ourName}.png  ${bytes.length} bytes`;
    } catch (cause) {
      lastError = String(cause);
    }
  }
  return `FAIL ${ourName} <- ${commonsName}: ${lastError}`;
}

// 串行下载：Commons 限流，并发会触发 429
const results = [];
for (const [ours, prefix, suitChar] of SUITS) {
  for (let rank = 1; rank <= 9; rank += 1) {
    // Commons 文件名形如 0101一萬：花色码 + 两位序号 + 中文点数 + 中文花色
    results.push(await fetchTile(`${ours}_${rank}`, `${prefix}${String(rank).padStart(2, "0")}${RANKS[rank - 1]}${suitChar}`));
  }
}
for (const line of results) console.log(line);
const failed = results.filter((line) => line.startsWith("FAIL"));
console.log(failed.length === 0 ? "\n全部 27 张下载成功" : `\n失败 ${failed.length} 张`);
process.exit(failed.length === 0 ? 0 : 1);
