// 从 Wikimedia Commons 经 weserv 图片代理下载麻将牌面（公有领域，作者 Shizhao）
// 源文件: https://commons.wikimedia.org/wiki/File:MJ1wan.svg 等 27 张
// 输出: apps/apk/assets/resources/tiles/tile_{wan|tong|tiao}_{1..9}.png
import fs from "node:fs";
import path from "node:path";

const SUITS = [
  ["wan", "wan"],
  ["tong", "bing"],
  ["tiao", "tiao"],
];

const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: node fetch-tiles.js <outDir>");
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

async function fetchTile(ourName, commonsName) {
  const target = `commons.wikimedia.org/wiki/Special:FilePath/${commonsName}.svg`;
  const url = `https://images.weserv.nl/?url=${encodeURIComponent(target)}&output=png&w=240`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) {
    return `FAIL ${ourName} <- ${commonsName}: HTTP ${response.status}`;
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const magic = bytes.subarray(0, 4).toString("hex");
  if (magic !== "89504e47") {
    return `FAIL ${ourName}: 非 PNG 内容 (${magic})`;
  }
  fs.writeFileSync(path.join(outDir, `${ourName}.png`), bytes);
  return `OK   ${ourName}.png  ${bytes.length} bytes`;
}

const jobs = [];
for (const [ours, commons] of SUITS) {
  for (let rank = 1; rank <= 9; rank += 1) {
    jobs.push(fetchTile(`${ours}_${rank}`, `MJ${rank}${commons}`));
  }
}
const results = await Promise.all(jobs);
for (const line of results) console.log(line);
const failed = results.filter((line) => line.startsWith("FAIL"));
console.log(failed.length === 0 ? "\n全部 27 张下载成功" : `\n失败 ${failed.length} 张`);
process.exit(failed.length === 0 ? 0 : 1);
