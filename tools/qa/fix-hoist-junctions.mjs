// 修复 pnpm hoist 层：把 .pnpm/node_modules 下（以及根 @types 下）由失败符号链接
// 留下的空目录补成 junction。仅 QA worktree 环境修复用，不提交。
import { readdirSync, existsSync, statSync, symlinkSync, rmdirSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const HOIST = path.join(ROOT, "node_modules", ".pnpm", "node_modules");
const PNM = path.join(ROOT, "node_modules", ".pnpm");

function toStoreDirs(name) {
  // 包名 -> .pnpm 里的目录名（"/" -> "+"），可能存在多版本
  const dirName = name.replace(/\//g, "+");
  let hits = [];
  for (const entry of readdirSync(PNM)) {
    if (entry.startsWith(dirName + "@") || entry === dirName) {
      const src = path.join(PNM, entry, "node_modules", name);
      if (existsSync(path.join(src, "package.json"))) hits.push(src);
    }
  }
  return hits;
}

let fixed = 0, skipped = 0, missing = 0;
const empties = [];
for (const name of readdirSync(HOIST)) {
  const p = path.join(HOIST, name);
  const st = statSync(p);
  if (!st.isDirectory()) continue;
  const items = readdirSync(p);
  if (items.length !== 0) continue; // 只处理空目录
  empties.push(name);
}
for (const name of empties) {
  const p = path.join(HOIST, name);
  const hits = toStoreDirs(name);
  if (hits.length === 0) { console.log("✗ 无源:", name); missing++; continue; }
  if (hits.length > 1) { console.log("! 多版本，取第一个:", name, hits.length); }
  rmdirSync(p);
  symlinkSync(hits[0], p, "junction");
  fixed++;
}
console.log(`hoist 层修复 ${fixed} 个，多版本/无源跳过 ${missing} 个`);

// 根 @types 下的空目录同样处理（tsc 隐式类型库发现走这里）
const TYPES = path.join(ROOT, "node_modules", "@types");
if (existsSync(TYPES)) {
  let tFixed = 0;
  for (const name of readdirSync(TYPES)) {
    const p = path.join(TYPES, name);
    if (statSync(p).isDirectory() && readdirSync(p).length === 0) {
      const hits = toStoreDirs("@types/" + name);
      if (hits.length === 0) { console.log("✗ 无源: @types/" + name); continue; }
      rmdirSync(p);
      symlinkSync(hits[0], p, "junction");
      tFixed++; fixed++;
    }
  }
  console.log(`@types 层修复 ${tFixed} 个`);
}
console.log("done");
