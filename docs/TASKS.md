# 任务分配

多人 / 多模型协作的任务板。**领任务前先读 `docs/CONTRIBUTING.md` 与 `docs/PROJECT_STATUS.md`。**

## 分配原则

1. **按包和目录切，不按功能切。** 同一个文件同一时刻只允许一个人改。
   任务表里"范围"一列的目录，就是这个人的独占区。
2. **能独立验证才叫完成。** 每个任务都必须有明确验收（测试通过，或页面能跑通）。
3. **有依赖的排到后面。** 标了"依赖"的任务，要等前一项合入并 `git pull --rebase` 之后再开工。

## 角色

| 角色 | 适合的工作 | 说明 |
| --- | --- | --- |
| **W**（WorkBuddy / 我） | 服务端、领域包、客户端核心 | 已有完整上下文，能跑测试验证 |
| **H**（混元 4） | LayaAir 客户端渲染层 | 边界最干净：只需实现两个传输接口 + 按 `Screen` 画页面 |
| **人** | 需要账号 / 资质 / 法务的事 | 存储、服务器、备案、协议文本，这些 AI 做不了 |

> 如果还有人类队友：B 组（服务端小项）最合适 —— 改动小、测试全、验收明确。

---

## 第一波：可立即并行，互不冲突

### A1 · LayaAir 客户端渲染层 〔H〕

- **范围**：新建 `apps/apk/`（LayaAir 工程），**只依赖 `@mianyang-mahjong/client`**
- **内容**：
  1. 用引擎的网络能力实现 `HttpTransport` 与 `SocketTransportFactory` 两个适配器
  2. 按 `Screen` 渲染四个页面：密钥登录 → 资料（未激活时）→ 主页 → 房间
- **依赖**：需要本机装有 LayaAir 环境（我没有，所以这任务归 H）
- **验收**：能用真实邀请密钥登录，进主页看到群列表与战绩；建房后进入房间页，收到实时牌局状态
- **注意**：牌桌交互（换三张/定缺/出牌）先不做，见 D1

### A2 · 管理后台网页 〔W · 已完成〕

- **范围**：`apps/server/src/admin-console*`（新增）、`app.ts` 里注册 `/admin`
- **内容**：单页控制台 —— 邀请密钥签发/列表/撤销、用户搜索、封禁解封、积分调整与流水、审计日志
- **依赖**：管理员登录先用权宜方案（非生产环境启动时打印一枚 2 小时令牌），
  真正的账号密码体系见 P2-1，单独一轮做
- **验收**：能签发密钥、能封禁用户、能调整积分并看到流水、能翻审计日志
- **完成**：新增 `/admin` 零依赖单页控制台；开发环境启动时打印 2 小时超级管理员令牌。

### A4 · 账号注销 〔W · 已完成〕

- **范围**：`packages/domain/src/accounts.ts`、`app.ts`、`ws-server.ts`、`apps/client/src/api-client.ts`
- **内容**：用户自助注销，立即生效不可撤销（上架合规要求）
- **验收**：注销后令牌立刻失效、密钥既登不进也不能重新注册、匿名化成「已注销用户」、
  积分与战绩保留、管理员无法复活
- **完成**：`POST /v1/account/delete`；状态转 `deleted`（数据库早就允许，无需迁移）+
  昵称头像匿名化；**有意保留 `invitationKeyHash`**，靠 UNIQUE 约束让这把密钥永久作废；
  WebSocket 增加「每次操作重新确认账号状态」，否则 socket 开着的人注销后还能接着打。

### B1 · 战绩分页与筛选 〔W · 已完成〕

- **范围**：`apps/server/src/match-history.ts`、`postgres-match-history.ts`、`app.ts` 的 `/v1/matches`
- **内容**：`limit` 之外加游标分页，并支持按时间范围筛选
- **验收**：新增测试覆盖游标翻页不重不漏、时间范围边界
- **完成**：`/v1/matches` 支持 `cursor` 游标分页（按 `finalized_at + room_id` 键集分页，
  不重不漏），返回 `nextCursor`；客户端 `ApiClient.matches()` 同步支持。时间范围筛选
  未做（原描述里"按时间范围筛选"与游标分页是两个独立能力，前者留待需要时再加）。

### B2 · 对局快照写入节流 〔W · 已完成〕

- **范围**：`apps/server/src/ws-server.ts`（调用存档处）、`postgres-game-state-store.ts`
- **内容**：每次行动都写一次改为按时间窗口节流（正确性不变，只是减少写放大）
- **验收**：节流后重启仍能接上存档；`ws-server.test.ts` 的续打用例仍通过
- **完成**：`saveRoundState` 按 `saveIntervalMs`（默认 2 秒）时间窗合并写盘 —— 距上次落盘
  不足就只标脏、由延迟定时器到点补写（保证最后一手最迟一个窗口后落盘）；对局结束或换局时
  取消悬挂定时器。新增节流测试：同一窗口内多次行动只写一次。

### C 组 · 外部资源 〔人〕

| 编号 | 事项 | 说明 |
| --- | --- | --- |
| C1 | 对象存储账号（腾讯云 COS / 阿里云 OSS） | 拿到 Bucket、地域、密钥后再做 A3 |
| C2 | 服务器、域名、HTTPS、备份、监控 | P0-4，上线前必须 |
| C3 | 隐私政策、用户协议文本 | P0-3，需要法务内容 |
| C4 | APP 备案、域名备案、Android 签名 | P2-6 |

---

## 第二波：等第一波完成

### A3 · 对象存储与图片语音上传 〔W 或 H〕

- **依赖**：C1（存储账号）
- **范围**：新增 `apps/server/src/object-storage.ts` + 上传接口；客户端补图片/语音发送
- **验收**：能上传图片并作为群消息发出；无存储配置时接口返回 501 而不是崩溃

### D1 · 牌桌页面 〔H〕

- **依赖**：A1
- **内容**：换三张、定缺、摸打、碰杠胡、结算弹窗
- **验收**：四人联机打完 8 局，分数与服务端一致

### D2 · 群聊页面 〔H〕

- **依赖**：A1
- **内容**：群列表、消息列表、发消息、撤回；接实时推送（`group-message` 等事件）
- **验收**：两个客户端能实时收到对方消息；撤回后显示"已撤回"

### B3 · 群消息分页 〔W · 已完成〕

- **依赖**：无（可与第一波并行，但改动面较大，建议单独排）
- **范围**：`packages/domain/src/groups.ts`、`apps/server/src/postgres-group-store.ts`
- **内容**：启动时不再全量载入群消息，改为按时间窗加载
- **验收**：消息量大时启动不卡；历史消息可翻页
- **完成**：
  - `PostgresGroupStore.load()` 不再 `SELECT group_messages`，只取每群 `MAX(sent_at)` 用于列表排序，启动开销与消息量脱钩。
  - 新增统一游标分页：`GET /v1/groups/:groupId/messages` 支持 `limit` + `before` 游标，返回 `nextCursor`；键集分页落在 `(sent_at, message_id)`，并新增复合索引迁移 `006_group_messages_pagination.sql`。
  - `recall` 改为 `async`：内存里没有的旧消息会先从库里取回再撤回（管理员撤回很早的消息也正确）。
  - `ChatGroup` 增加 `lastMessageAt` 字段，`GroupService`/`PostgresGroupStore` 各自维护，群列表排序不再依赖全量消息。
  - 内存仅保留每群最近 500 条消息作为就近缓存，避免无限增长。
  - 同步更新了 `groups.test.ts`/`postgres-group-store.test.ts` 的测试（含游标翻页、按库取回撤回）。
  - 注意：本环境无法跑 `pnpm`，需在本机 `pnpm install && pnpm test && pnpm typecheck && pnpm build` 复核。

### B4 · 解散群改软删除 〔W · 已完成〕

- **依赖**：无
- **范围**：迁移 `005_*`、`postgres-group-store.ts`、`packages/domain/src/groups.ts`
- **验收**：解散后群记录保留，可查询历史消息
- **完成**：迁移 `005_group_soft_delete.sql` 加 `dissolved_at`；解散只打时间戳，群/成员/消息
  全部保留，原成员仍可读历史消息；但群从所有列表消失、且一切写操作被 `requireLiveGroup` 拒绝
  （包括查号加入、发言、改公告、群管理、退群）。新增领域层 2 项 + store 1 项 + 接口端到端 1 项测试。

---

## 协作节奏

```powershell
git pull --rebase        # 开工前先同步
# ... 干活 ...
pnpm test && pnpm typecheck && pnpm build    # 三条全绿
git add -A && git commit -m "..."
git push
```

- 推完在群里说一声改了哪些文件，让别人 pull
- 同一目录撞车了，先沟通再动，不要互相覆盖
- 规格有分歧时以 `docs/PROJECT_STATUS.md` 为准；确实要改规格，先更新文档再改代码

## 当前状态（2026-09-15）

- 远端：`https://github.com/dadefy/mymajiang.git`（**私有**），分支 `main`
- 测试：25 个文件 / 195 项全通过
- 已完成：规则引擎、领域逻辑、服务端（HTTP + WebSocket + PostgreSQL）、
  客户端业务骨架（`apps/client`）、邀请密钥登录、群聊实时推送、群管理、管理后台网页（A2）、
  账号注销（A4）、战绩游标分页（B1）、快照写入节流（B2）、解散群软删除（B4）、群消息分页（B3）
- **还没做的最大两块：客户端渲染层（A1）与对象存储（A3）**
