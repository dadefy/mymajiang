# 麻雀精灵 · 视觉优化待办（FINAL VISUAL POLISH 阶段使用）

> 本文件登记系统集成验收阶段发现的**非阻塞视觉问题**（P3 visual polish）。
> 这些问题不阻塞 SYSTEM INTEGRATED，但阻塞 RELEASE CANDIDATE 的最终美术验收。
> 格式：page/state / resolution / issue / severity / screenshot / recommended next step

| page/state | resolution | issue | severity | screenshot | recommended next step |
|---|---|---|---|---|---|
| room-waiting | 1920×1080 | 中央翡翠麻将桌为纯 CSS 渐变示意，缺少真实玉质纹理与桌面景深 | P3 | design/screenshots/10-room-waiting-1920.png | FINAL VISUAL POLISH 阶段接入美术桌面贴图 |
| room-waiting | 1920×1080 | 座位卡头像为占位首字圆，无真实头像框材质 | P3 | 同上 | 接 AvatarFrame 组件与真实 avatarUrl |
| lobby | 1920×1080 | 功能卡插图当前为 emoji 示意（🀄/🔢/💬），需替换 A2 card_* 插画资源 | P2 | design/screenshots/02-lobby-1920.png | 按 manifest 接入 card_create_room / card_join_room / card_group |
| group-chat | 1920×1080 | 输入栏/导航图标为文字示意（图/🎤/😊），需替换 A2 image/voice/emoji 图标 | P2 | design/screenshots/06-group-chat-1920.png | 按 manifest 接入 image/voice/emoji/send |
| room-waiting | 1920×1080 | 「已复制」轻提示视觉未设计（当前逻辑仅 console/toast 占位） | P3 | — | 统一轻提示组件 |
| global | 全部 | 国风装饰细节（云纹/竹叶/窗格）为极简 CSS 示意 | P3 | — | FINAL VISUAL POLISH 统一绘制 |
