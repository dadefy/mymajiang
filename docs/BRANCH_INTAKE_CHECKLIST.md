# 并行分支交付接收 Checklist

> 依据 QA 审计规范第四十一节建立。任何并行开发分支的交付物，在合入 `main` 之前
> 必须按本文档逐项过一遍并留下记录 —— 没有记录的接收等于没接收。
>
> 放在 QA worktree（`feature/qa-integration-guard`）下维护，随分支收口一起归档。

## 一、使用方式

1. 每个待接收分支在第三节表格里登记一行；
2. 按第二节的清单逐项执行，把命令输出摘要填进「证据」列（日志文件或提交号皆可）；
3. 全部绿 → 允许合入 `main`；有红 → 挂「遗留问题」，分支不得合入；
4. 本文档的修改与分支合并走同一套提交规范（小步、可回滚、消息说清为什么）。

## 二、逐项检查清单

每项都给「怎么做」和「什么算过」：

| # | 项目 | 怎么做 | 什么算过 |
|---|------|--------|----------|
| 1 | **branch** | `git branch --list <分支>` 确认分支存在且已推远端 | 分支名与交付人申报一致 |
| 2 | **base** | `git merge-base main <分支>`，确认基线不是太旧的 main | 基线落后 main 超过 1 周或跨过大改（如 migration），先 rebase 再接收 |
| 3 | **HEAD** | `git rev-parse --short <分支>` | 与交付人申报的 HEAD 一致（防止收了旧代码） |
| 4 | **changed files** | `git diff --stat main...<分支>`（三点：只看分支自己的改动） | 改动范围与申报的功能相符；出现无关文件要问清 |
| 5 | **status** | 在该分支的工作区跑 `git status --porcelain -uall` | 干净；有未提交改动先让交付人提交或说明 |
| 6 | **build** | `pnpm build` | 退出码 0，无新告警 |
| 7 | **typecheck** | `pnpm typecheck` | 退出码 0 |
| 8 | **test** | `pnpm test` | 全绿；跳过数与基线相比没有增加 |
| 9 | **qa** | `pnpm qa`（offline 层）；涉及服务端/实时的还要 `node tools/qa/run-regression.mjs local-online` | 全绿；新增功能必须带了对应的回归步骤或测试 |
| 10 | **Laya build**（仅 `feature/laya-client`） | 按 laya-client 分支自带的构建说明跑一遍构建产物 | 产物可打开、可进对局；该分支未动则记 `N/A` |
| 11 | **evidence** | 把 6–10 的输出存档（日志文件路径或 CI 链接），记录在表格里 | 每一项都能追溯到原始输出，不接受「我本地跑过」的口头结论 |
| 12 | **remaining issues** | 接收中发现但没当场解决的问题，逐条列出并指认跟进人 | 有红的分支必须有此列内容；全绿的分支写「无」 |

## 三、当前分支登记表

> 快照生成于 2026-09-18，由 QA worktree（`feature/qa-integration-guard`）登记。
> 后续每收一个分支更新一行，不要另开新表。

| 分支 | base（merge-base） | HEAD | 改动概要 | status | build | typecheck | test | qa | Laya build | 证据 | 遗留问题 |
|------|--------------------|------|----------|--------|-------|-----------|------|-----|------------|------|----------|
| `main` | — | `f675d64` | 基线 | 干净 | ✓ | ✓ | 546 项 ✓ | ✓（offline） | N/A | qa 报告（2026-09-18） | 无 |
| `feature/qa-integration-guard` | 基于 `f675d64` | `3bcdce9` | QA 回归套件 + 运行器修复 + 弃局 E2E + 本文档 | 干净 | ✓ | ✓ | 546 项 ✓ | ✓（offline + local-online，含空格路径 Node） | N/A | `qa-run-spaces6.log`（8 步全绿）、弃局 E2E 19 项全绿（2026-09-18） | 浏览器侧人工项：结算面板只弹一次、知道了关闭返回大厅（见 abandonment-acceptance 脚本尾部提示） |
| `android-shell` | 基于 `f675d64` | `72a8002` | 纯 WebView 安卓壳（apps/android-shell，14 文件） | 干净（`apps/apk/package.json` 的他人改动未纳入） | ✓ | ✓ | 546 项 ✓ | ✓（offline） | N/A | `app-debug.apk`（14KB 壳）gradle/gradlew 双路构建成功（2026-09-18） | 真机 adb 验收待设备接入 |
| `feature/laya-client` | 待核对 | `fc3c8a4` | Laya 客户端（历史分支，曾因 .git 事故丢对象、已从远端恢复） | 待交付人申报 | 待验 | 待验 | 待验 | 待验 | **必验** | 待接收 | 分支恢复后未与 main 对过差异，接收前先做第 4 项改动盘点 |

## 四、判定与后续

* **全绿** → 在登记表「遗留问题」写「无」，按 `git merge --no-ff` 合入（保留分支形状，方便回溯），合入后删除登记行或标记「已收」。
* **有红** → 分支保持不合入；把红色项与责任人在「遗留问题」列写清，下次接收只复跑红色项与受影响项。
* **接收后 main 出红** → 优先回滚合并提交而不是在 main 上追修；追修应该回到来源分支做。
* 本文档自身也是交付物：改它同样走 checklist 第 5–8 项（文档改动至少保证 build/typecheck 不红）。
