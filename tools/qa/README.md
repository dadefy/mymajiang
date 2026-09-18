# 一键回归（tools/qa）

一条命令回答：**「这个功能到底真的没坏，还是只是看起来没坏？」**

```powershell
pnpm qa                    # offline：build + typecheck + 单测全量 + 5 个离线 domcheck 探针
pnpm qa:local-online       # 需要本机 3000 有服务端：smoke + acceptance（四人 8 局端到端）
pnpm qa:public-online      # 公网：/health + smoke（默认 https://0106.wiki，可用 SERVER_BASE_URL 覆盖）
node tools/qa/run-regression.mjs manual    # 打印真机人工验收清单入口
node tools/qa/run-regression.mjs all       # offline + local-online + public-online 串跑
```

## 风险 → 守护者映射（offline 档实际验到的）

| 风险 | 守护者 |
| --- | --- |
| 四人全部退出/失联：当前小局作废、已完成小局保留、大局正常结算 | `ws-server.test.ts`「条件 A/B/混合形态」组 |
| 窗口定时器撞墙钟 1ms 边界不卡死（掉线终局丢失） | `ws-server.test.ts`「条件 B 兜底：短重试」 |
| 断线 → 托管 → 重连 → 重新接管 | `ws-server.test.ts`「退出托管与重新接管」组 + `check-takeover-flow.mjs` |
| 三票解散：四家 match-finished、托管停摆 | `ws-server.test.ts`「REST 三票解散：实时层收尾」 |
| claiming deadline 不因广播/重连延长 | `ws-server.test.ts`「claiming 窗口 deadline 固定」 |
| 直杠/暗杠/补杠积分正确且零和 | `game.test.ts`「杠分：直杠 2 分、暗杠各家 2、补杠各家 1」 |
| 8 小场跑完积分只结算一次、raw_delta 跨重启恢复 | `postgres-room-store.test.ts` + `ws-server.test.ts` 重启续打组 |
| 结算浮层真的画出来、整局结算可关闭 | `check-countdown.mjs` / `check-match-points.mjs` / `check-match-dismiss.mjs`（后者要服务端） |
| 整局结束后「回到对局」入口消失 | `acceptance.mjs`（local-online 档） |
| finished 不会退化成 dissolved、多次请求不重复结算 | `domain.test.ts` / `postgres-room-store.test.ts` 终局幂等组 |
| 幂等键 | `idempotency.test.ts` + `app.test.ts` 幂等接线组 |
| WS 断线重连不重复订阅/重复动作 | `match-socket.test.ts` 重连重放组 + `ws-server.test.ts`「同一座位反复 auth」 |

## 档位与真实环境的关系

- **offline**：全部可机器判定，CI/提交前必跑。
- **local-online**：验「真进程、真连接」这条链，改动服务端后跑一次。
- **public-online**：只验线上活着、接口通；**验的是已部署的那份代码**——改了没部署它会红，
  这正是它的用途。完整线上行为用 `tools/domcheck/check-remote.mjs`（要 4 把密钥）。
- **manual-device**：真机清单在 `docs/INTERNAL_TESTING.md` 第七节。
  自动化永远验不到的：Android 相册/麦克风桥接、横屏分辨率、弱网、长时间运行、云存储直传的真机行为。

## 假绿防线（QA 原则）

断言本身也会错。每个关键探针都必须**至少真的失败过一次**（mutation 验证：
临时改坏实现 → 确认测试变红 → 还原 → 变绿），没红过的断言不算数。
2026-09-18 的 mutation 记录见 `docs/PROJECT_STATUS.md` 第 7 节。
