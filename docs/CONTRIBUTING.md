# 协作规范（人 / AI 协作者通用）

本项目可能同时有多个开发者参与 —— 包括人类、WorkBuddy、混元等不同 AI。
**最大的风险不是模型能力，而是两个编辑器同时改同一批文件、且没有版本控制。**
这份文档就是为了避免这件事。

## 1. 开工前先读这三份

| 顺序 | 文件 | 看什么 |
| --- | --- | --- |
| 1 | `docs/PROJECT_STATUS.md` | 产品规则、已完成功能、接口清单、已知限制 |
| 2 | `docs/PROJECT_STATUS.md` 第 11 节 | 「下一位开发者开始工作前」的 19 条硬规则 |
| 3 | `apps/client/README.md`（若动客户端） | 分层、两个传输接口、页面流 |

`PROJECT_STATUS.md` 是**唯一的事实来源**。规格与代码冲突时，改代码，不要改规格——
除非讨论后确认是规格要变（变规格必须同步更新本文档和 README）。

## 2. 版本控制

`mianyang-mahjong` 已有自己的 git 仓库（初始提交 `db0cbd0`，分支 `master`，
96 个文件 / 14768 行）。**每次完成一个可验证的改动就提交一次，不要攒一大坨。**

```powershell
cd mianyang-mahjong
git add -A
git commit -m "简述改了什么、为什么"
git status          # 应为空
```

两个环境上的坑：

- 本机 `git` 不在 PATH 里，用完整路径
  `C:\Users\Administrator\.workbuddy\binaries\PortableGit\versions\1.2.0\cmd\git.exe`。
- 提交信息是 UTF-8 中文，**用 `-F 消息文件` 提交**，不要用 `-m`（PowerShell 传中文会乱码）。
  文件要用无 BOM 的 UTF-8 写。

### 远端

**目前没有配置任何远端**，代码只在本机。要推到 GitHub / Gitee 需要你先在网站上建一个空仓库，
然后把地址给出来（或配好凭据），再执行：

```powershell
git remote add origin <仓库地址>
git push -u origin master
```

`.gitignore` 已排除 `node_modules/`、`dist/`、`coverage/`、`.env*`。
规则书与实施书两个 `.docx` 已随仓库提交（它们是产品规则的来源）。

## 3. 分工：按包切，不要按功能切

同一个包、同一个文件**同一时刻只允许一个开发者在改**。建议的归属：

| 范围 | 说明 |
| --- | --- |
| `packages/rules` | 规则引擎。改动必须让 `game-state.test.ts` 的逐手往返校验通过 |
| `packages/domain` | 账号、好友、群聊、房间、积分领域逻辑 |
| `apps/server` | HTTP / WebSocket、持久化仓库、迁移 |
| `apps/client` | 客户端业务骨架（协议、调用、通道、页面流） |
| 渲染层（LayaAir） | 只依赖 `apps/client` 的两个传输接口与 `Screen`，不碰业务 |

交接时在 PR / 消息里写清三件事：**改了哪些文件、为什么这么改、怎么验证**。

## 4. 完成的定义：三条命令全绿

```powershell
pnpm test        # 全部测试（当前 25 个文件 / 183 项）
pnpm typecheck   # 各包类型检查
pnpm build       # 生产构建
```

三条都必须通过，才算完成。任何一条红了就别提交。

两个容易踩的坑：

- 服务端的 `tsconfig.json` **排除了 `*.test.ts`**，所以 `pnpm typecheck`
  查不到测试文件里的类型错误。要查就得临时加一个 `exclude: []` 的 tsconfig（用完删掉）。
- 改了 `packages/rules` 或 `packages/domain` 的类型后，**先构建这两个包**再测服务端，
  否则服务端还在用旧的 `dist`。

## 5. 给新 AI 协作者的开场提示词（可直接粘贴）

> 你在参与一个 TypeScript 单体仓库的麻将游戏项目，目录
> `C:\Users\Administrator\Documents\Codex\2026-09-13\wo\mianyang-mahjong`。
> 开工前先完整读完 `docs/PROJECT_STATUS.md`（尤其第 11 节的 19 条硬规则）
> 和本文件（docs/CONTRIBUTING.md），有不清楚的地方先问，不要猜。
>
> 本次任务范围：**（在此写明具体的包 / 文件 / 功能，越窄越好）**。
> 不要改动范围以外的文件；不要重构你没被要求改的代码。
>
> 完成后必须依次跑 `pnpm test`、`pnpm typecheck`、`pnpm build`，三条全绿才算完成；
> 任何一条失败就修到自己那部分通过为止，不要绕过。
> 改完请汇报：改了哪些文件、为什么这么改、测试结果是多少项通过。

## 6. 决策记录

有分歧或新决定的事，写进 `docs/PROJECT_STATUS.md` 的对应小节，不要只留在聊天里。
聊天记录会丢，文档不会。

**已经被推翻过、不要再做的决定**（避免新协作者走回头路）：

- 不做手机短信验证码，改用开发方签发的一次性邀请密钥（见 4.3）。
- 不做注册申请与人工审核，拿到密钥就能建号（见 4.3）。
- 不用手机号做任何标识，`users.phone_fingerprint` 已随迁移 004 删除。
- 客户端业务代码不碰 DOM / LayaAir，环境差异只收在两个传输接口里。
