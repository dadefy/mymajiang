// QA worktree 专用：修复 pnpm 安装在沙箱里符号链接失败留下的所有"空包目录"。
// 显式枚举每个 node_modules 根（根目录 + 5 个 workspace 包），逐个修复：
//   - <nm>/<name>            空目录 → workspace 包或 <nm>/.pnpm 里的真身
//   - <nm>/@scope/<name>     空目录 → 同上
//   - <nm>/.pnpm/node_modules/<name>  空目录 → <nm>/.pnpm/<name'@*>/node_modules/<name>
// 仅环境修复用，不随业务提交。
import { readdirSync, existsSync, statSync, symlinkSync, rmdirSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

const WORKSPACE_PKGS = {
  "@mianyang-mahjong/client": "apps/client",
  "@mianyang-mahjong/rules": "packages/rules",
  "@mianyang-mahjong/domain": "packages/domain",
  "@mianyang-mahjong/server": "apps/server",
  "@mianyang-mahjong/apk": "apps/apk",
};

const NM_ROOTS = [
  path.join(ROOT, "node_modules"),
  ...["apps/client", "apps/server", "apps/apk", "packages/rules", "packages/domain"]
    .map((p) => path.join(ROOT, p, "node_modules")).filter(existsSync),
];

function pnpmCandidates(pnpmDir, name) {
  const dirName = name.replace(/\//g, "+");
  const hits = [];
  if (!existsSync(pnpmDir)) return hits;
  for (const entry of readdirSync(pnpmDir)) {
    // pnpm 会把超长目录名截断成 <前缀>_<hash>：去掉 hash 后做前缀匹配，
    // 并用 package.json 的 name 字段做最终确认
    const stripped = entry.replace(/_[0-9a-f]{16,64}$/, "");
    const nameMatch = entry === dirName || entry.startsWith(dirName + "@")
      || (dirName.startsWith(stripped) && stripped.length >= 8);
    if (!nameMatch) continue;
    const src = path.join(pnpmDir, entry, "node_modules", name);
    try {
      const pkg = JSON.parse(await_import(path.join(src, "package.json")));
      if (pkg.name === name) hits.push(src);
    } catch { /* 目录缺失或非包，跳过 */ }
  }
  return hits;
}

import { readFileSync } from "node:fs";
function await_import(p) {
  return readFileSync(p, "utf8");
}

function linkEmptyTo(p, target) {
  rmdirSync(p);
  symlinkSync(target, p, "junction");
}

let fixed = 0, failed = 0;

for (const nm of NM_ROOTS) {
  const pnpmDir = path.join(nm, ".pnpm");

  // 1) hoist 层 .pnpm/node_modules/*
  const hoist = path.join(pnpmDir, "node_modules");
  if (existsSync(hoist)) {
    for (const name of readdirSync(hoist)) {
      const hp = path.join(hoist, name);
      let st; try { st = statSync(hp); } catch { continue; }
      if (!st.isDirectory() || readdirSync(hp).length !== 0) continue;
      const cands = pnpmCandidates(pnpmDir, name);
      if (cands.length) { linkEmptyTo(hp, cands[0]); fixed++; }
      else { console.log("✗ hoist 无源:", path.relative(ROOT, hp)); failed++; }
    }
  }

  // 1.5) 每个虚拟包内部 node_modules/<dep> 的空链接（依赖的依赖）
  if (existsSync(pnpmDir)) {
    const rootPnpm = path.join(ROOT, "node_modules", ".pnpm");
    for (const v of readdirSync(pnpmDir)) {
      if (v === "node_modules") continue;
      const vnm = path.join(pnpmDir, v, "node_modules");
      if (!existsSync(vnm)) continue;
      for (const dep of readdirSync(vnm)) {
        const dp = path.join(vnm, dep);
        let st; try { st = statSync(dp); } catch { continue; }
        if (!st.isDirectory()) continue;
        // scope 目录：始终下钻修空子包（scope 本身可能一半空一半非空）
        if (dep.startsWith("@")) {
          for (const sub of readdirSync(dp)) {
            const sp = path.join(dp, sub);
            let sst; try { sst = statSync(sp); } catch { continue; }
            if (!sst.isDirectory() || readdirSync(sp).length !== 0) continue;
            const name2 = dep + "/" + sub;
            const cands = pnpmCandidates(pnpmDir, name2).length
              ? pnpmCandidates(pnpmDir, name2)
              : pnpmCandidates(rootPnpm, name2);
            if (cands.length) { linkEmptyTo(sp, cands[0]); fixed++; }
            else { console.log("✗ 虚拟包 scope 依赖无源:", path.relative(ROOT, sp)); failed++; }
          }
          continue;
        }
        if (readdirSync(dp).length !== 0) continue;
        const cands = pnpmCandidates(pnpmDir, dep).length
          ? pnpmCandidates(pnpmDir, dep)
          : pnpmCandidates(rootPnpm, dep);
        if (cands.length) { linkEmptyTo(dp, cands[0]); fixed++; }
        else { console.log("✗ 虚拟包依赖无源:", path.relative(ROOT, dp)); failed++; }
      }
    }
  }

  // 2) 直接包链接
  for (const entry of readdirSync(nm)) {
    if (entry === ".pnpm" || entry === ".bin" || entry.startsWith(".")) continue;
    const p = path.join(nm, entry);
    let st; try { st = statSync(p); } catch { continue; }
    if (!st.isDirectory()) continue;

    if (entry.startsWith("@")) {
      // scope 目录：逐个子包检查
      for (const sub of readdirSync(p)) {
        const sp = path.join(p, sub);
        let sst; try { sst = statSync(sp); } catch { continue; }
        if (!sst.isDirectory() || readdirSync(sp).length !== 0) continue;
        const name = entry + "/" + sub;
        const wp = WORKSPACE_PKGS[name];
        if (wp && existsSync(path.join(ROOT, wp))) {
          linkEmptyTo(sp, path.join(ROOT, wp)); fixed++;
          continue;
        }
        const cands = pnpmCandidates(pnpmDir, name) ;
        const cands2 = cands.length ? cands : pnpmCandidates(path.join(ROOT, "node_modules", ".pnpm"), name);
        if (cands2.length) { linkEmptyTo(sp, cands2[0]); fixed++; }
        else { console.log("✗ scope 包无源:", path.relative(ROOT, sp)); failed++; }
      }
      continue;
    }

    if (readdirSync(p).length !== 0) continue;
    const wp = WORKSPACE_PKGS[entry];
    if (wp && existsSync(path.join(ROOT, wp))) {
      linkEmptyTo(p, path.join(ROOT, wp)); fixed++;
      continue;
    }
    let cands = pnpmCandidates(pnpmDir, entry);
    if (!cands.length) cands = pnpmCandidates(path.join(ROOT, "node_modules", ".pnpm"), entry);
    if (cands.length) { linkEmptyTo(p, cands[0]); fixed++; }
    else { console.log("✗ 包无源:", path.relative(ROOT, p)); failed++; }
  }
}

console.log(`修复 ${fixed} 个，失败 ${failed} 个`);
