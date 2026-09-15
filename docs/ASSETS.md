# 素材来源登记

上架合规要求素材来源可追溯。**每个进入仓库的第三方素材都在这里登记**：
来源、授权、下载日期、加工方式。新素材入仓库前先补一行。

## 麻将牌面（万 / 筒 / 条 × 1–9，共 27 张）

- **位置**：`apps/apk/assets/resources/tiles/`，命名 `花色_点数` → `wan_1.png` … `tiao_9.png`
  （筒 = Commons 上的「餅 / bing」，条 = 「條 / tiao」）
- **来源**：Wikimedia Commons，「0101一萬」系列（Unicode 麻将牌 SVG 集）：
  - 万：`File:0101一萬.svg` … `File:0109九萬.svg`
  - 筒：`File:0201一餅.svg` … `File:0209九餅.svg`
  - 条：`File:0301一條.svg` … `File:0309九條.svg`
  - 分类页：`Category:SVG Planar illustrations of Mahjong tiles`
- **授权**：**CC BY-SA 4.0**（作者 碧海风，2018-07-10 自传作品）。
  **两条义务，上架/分发前必须落实**：
  1. **署名**——App 内（关于/致谢页）标注：牌面素材 © 碧海风，CC BY-SA 4.0，
     来源 Wikimedia Commons（附分类或文件页链接）；本文档即仓库侧登记。
  2. **相同方式共享**——这 27 张图（含对它们的修改）对外分发时继续按 CC BY-SA 4.0 授权；
     只约束这批图片本身，不波及游戏代码。
  授权抽查：`0101一萬.svg`、`0301一條.svg` 两张确认（同批同作者，2026-09-16）。
- **下载日期**：2026-09-16
- **加工**：Commons 服务端栅格化的 250px PNG（250×358，透明背景，共约 368KB），
  经 images.weserv.nl 代理取回（本机直连 Wikimedia 被网络阻断），无其他修改。
  **注意**：牌框与数字为黑色线稿、背景透明——深色界面渲染时需垫白色圆角底
  （效果即 Commons 白底预览的经典牌面）。
- **复现**：`node apps/apk/tools/fetch-tiles.mjs <输出目录>`
  （脚本按 Commons 规则本地计算 md5 缩略图直链：`md5(完整文件名含 .svg)` 前 1/2 字符作目录，
  `250px-<名>.svg.png`；不走 `Special:FilePath`——该 wiki 路由对代理 IP 限流极严，会 429）。

### 落选 / 备用记录（避免重复筛选）

- 同分类 `MJ1wan.svg` … `MJ9tiao.svg` 系列：**公有领域**（作者 Shizhao），曾短暂采用后被替换；
  如需零义务方案可换回（获取方式见 git 历史 ea21a2c）。
- OpenGameArt「Mahjong Tileset」：CC-BY 3.0 可用但需署名
  （<https://opengameart.org/content/mahjong-tileset>）。
- itch.io 上的像素/立直风格包（本机网络无法直接验证授权原文），暂未采用。

## 待登记

- 按钮 / 面板底图（如采用 `assets/atlas/comp/` 里 LayaAir 自带组件图，其授权随 LayaAir 引擎协议，需在采用时核对并登记）。
