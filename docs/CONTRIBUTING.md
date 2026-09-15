# 协作规范（人 / AI 协作者通用）

本项目可能同时有多个开发者参与 —— 包括人类、WorkBuddy、混元等不同 AI。
**最大的风险不是模型能力，而是两个编辑器同时改同一批文件、且没有版本控制。**
这份文档就是为了避免这件事。

## 1. 开工前先读这几份

| 顺序 | 文件 | 看什么 |
| --- | --- | --- |
| 1 | `docs/TASKS.md` | **任务分配**：你负责哪块、范围到哪个目录、验收是什么 |
| 2 | `docs/PROJECT_STATUS.md` | 产品规则、已完成功能、接口清单、已知限制 |
| 3 | `docs/PROJECT_STATUS.md` 第 11 节 | 「下一位开发者开始工作前」的 19 条硬规则 |
| 4 | `apps/client/README.md`（若动客户端） | 分层、两个传输接口、页面流 |

`PROJECT_STATUS.md` 是**唯一的事实来源**。规格与代码冲突时，改代码，不要改规格——
除非讨论后确认是规格要变（变规格必须同步更新本文档和 README）。

## 2. 版本控制

`mianyang-mahjong` 已有自己的 git 仓库（分支 `main`）。
**每次完成一个可验证的改动就提交一次，不要攒一大坨。**

```powershell
cd mianyang-mahjong
git status                    # 先看清楚有哪些改动
git add <你自己改的路径...>     # 只加自己的文件，见下
git commit -F 消息文件
git status                    # 应为空
```

### ⚠️ 不要用 `git add -A` / `git add .`

**这个仓库只有一个工作区，多个协作者共用。** `git add -A` 会把别人**还没提交**的改动
一起扫进你的提交里 —— 这不是假设，本项目真的发生过：一次「B1 战绩分页」的提交
带进了 103 个 `apps/apk` 下的文件（另一个人正在做的 LayaAir 工程），
提交信息里一个字都没提，事后只能靠 `git log --name-only` 才查出来。

正确做法：

```powershell
git status                          # 确认改动清单
git add packages/domain/src/groups.ts apps/server/src/postgres-group-store.ts
git status                          # 再确认一次，只应有你要提交的文件
```

提交前如果看到不认识的改动，**停下来问一句**，不要顺手提交。

### 不要提交生成物与第三方文件

`.gitignore` 已排除 `node_modules/`、`dist/`、`coverage/`、`.env*`；
`apps/apk/.gitignore` 另外排除了 `library/`、`local/`、`release/`、`temp/`、`bin/js/bundles`。

引擎自带的类型文件（`apps/apk/engine/types/*.d.ts`，单文件两万多行）目前**进了仓库**，
仓库 `.git` 合计 2.1 MB 尚可接受；但若再引入别的引擎或 SDK 资源，先确认是不是生成物，
能 gitignore 就别提交。

两个环境上的坑：

- 本机 `git` 不在 PATH 里。**要用真正的 git 本体**，而不是 `cmd\git.exe` 这个 wrapper：
  `C:\Users\Administrator\.workbuddy\binaries\PortableGit\versions\1.2.0\mingw64\bin\git.exe`
  （wrapper 找不到 `git-remote-https`，push 会报 `remote-https is not a git command`）。
  用本体时还要把 `GIT_EXEC_PATH` 指到同一个 `mingw64\bin` 目录。
- 提交信息是 UTF-8 中文，**用 `-F 消息文件` 提交**，不要用 `-m`（PowerShell 传中文会乱码）。
  文件要用无 BOM 的 UTF-8 写。

### 提交身份（多个 AI 协作时务必区分）

仓库级身份是 `Administrator <administrator@localhost>`，所有协作者共用。**提交前必须
用环境变量覆盖成自己的身份**，否则提交历史里分不清是谁干的：

| 协作者 | GIT_AUTHOR_NAME / GIT_COMMITTER_NAME | email |
| --- | --- | --- |
| WorkBuddy（我） | `WorkBuddy` | `workbuddy@local` |
| 混元 4 | `Hunyuan` | `hunyuan@local` |
| 人类开发者 | 你的真实姓名 | 你的真实邮箱 |

```powershell
$env:GIT_AUTHOR_NAME = "WorkBuddy"
$env:GIT_AUTHOR_EMAIL = "workbuddy@local"
$env:GIT_COMMITTER_NAME = "WorkBuddy"
$env:GIT_COMMITTER_EMAIL = "workbuddy@local"
# ... 然后 git add / git commit ...
```

提交后可用 `git log -1 --format="%an <%ae>"` 核对。**混元把上表的 `WorkBuddy` 换成
`Hunyuan` / `hunyuan@local` 即可**，不要照抄。

### 远端

- 远端：`origin = https://github.com/dadefy/mymajiang.git`
- 默认分支：`main`
- **该仓库是私有的**（2026-09-15 由公开转为私有），未授权访问返回 404。

```powershell
git push -u origin main      # 首次
git push                     # 之后
git pull --rebase            # 开始干活前先同步
```

推送需要 Personal Access Token 当密码（GitHub 设置里生成，勾 `repo`）。

> 仓库里包含两份产品文档（`绵阳血战麻将游戏规则_v1.0.docx`、
> `四川血战麻将APK_AI开发实施书.docx`）。它们之所以安全，是因为**仓库是私有的**——
> 一旦有人把它转成公开，这两份文档会立刻变为全网可见，而且历史提交里也留着，
> 改回私有之前的那段时间内可能已被抓取。所以：**不要把它转成公开**。
>
> 另外，私有不等于可以随便提交密钥：真实密钥仍然只放 `.env`（已被 gitignore），
> 一旦误提交进历史，改私有也救不回来。

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
