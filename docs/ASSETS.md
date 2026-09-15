# 素材来源登记

上架合规要求素材来源可追溯。**每个进入仓库的第三方素材都在这里登记**：
来源、授权、下载日期、加工方式。新素材入仓库前先补一行。

## 麻将牌面（万 / 筒 / 条 × 1–9，共 27 张）

- **位置**：`apps/apk/assets/resources/tiles/`，命名 `tile 花色_点数` → `wan_1.png` … `tiao_9.png`
  （筒 = Commons 上的「餅 / bing」，条 = 「條 / tiao」）
- **来源**：Wikimedia Commons，`MJ` 系列（Unicode 麻将牌 SVG 集）：
  - 万：`File:MJ1wan.svg` … `File:MJ9wan.svg`
  - 筒：`File:MJ1bing.svg` … `File:MJ9bing.svg`
  - 条：`File:MJ1tiao.svg` … `File:MJ9tiao.svg`
  - 分类页：`Category:SVG Planar illustrations of Mahjong tiles`
- **授权**：**公有领域**（作者 Shizhao 放弃版权，另按 GPLv2 双许可；游戏素材按 PD 使用，
  无署名义务）。抽查记录：`File:MJ1wan.svg` 页面明确标注 released into the public domain。
- **下载日期**：2026-09-16
- **加工**：Commons 服务端把 SVG 栅格化 → 经 images.weserv.nl 代理取回（本机直连 Wikimedia
  被网络阻断）→ 240×305 PNG（透明背景），无其他修改。
- **复现**：`node apps/apk/tools/fetch-tiles.mjs <输出目录>`（脚本内注明源文件名）。
- **规格**：27 张 × 240×305，共约 641KB；万=蓝红汉字、筒=花心圆圈、条=红绿条棍，风格统一。

### 落选记录（避免重复筛选）

- 同分类的 `0101一萬.svg` … `0309九條.svg` 系列：**CC BY-SA 4.0**（作者 碧海风），
  因 Share-Alike 传染性落选。
- OpenGameArt「Mahjong Tileset」：CC-BY 3.0 可用但需署名，作为备选保留
  （<https://opengameart.org/content/mahjong-tileset>）。
- itch.io 上的像素/立直风格包（本机网络无法直接验证授权原文），暂未采用。

## 待登记

- 按钮 / 面板底图（如采用 `assets/atlas/comp/` 里 LayaAir 自带组件图，其授权随 LayaAir 引擎协议，需在采用时核对并登记）。
