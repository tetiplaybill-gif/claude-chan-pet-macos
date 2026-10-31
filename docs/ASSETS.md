# 素材说明

本公开版本包含来自 [Mushan08/claude-chan-pet](https://github.com/Mushan08/claude-chan-pet) 的人物图片与动画，作者署名保留为 **MushanLuo / Mushan08**，固定来源为提交 [`7573579a5a7ade4a853c38144f664b3abf11bbba`](https://github.com/Mushan08/claude-chan-pet/tree/7573579a5a7ade4a853c38144f664b3abf11bbba/assets/pet)。

## 收录范围

| 路径 | 数量 | 用途 |
| --- | --- | --- |
| `assets/pet/front.png`、`side.png`、`back.png` | 3 张 PNG | 人物立绘姿态 |
| `assets/pet/face-01.png` 至 `face-10.png` | 10 张 PNG | 表情 |
| `assets/pet/anims/` 中的 WebM | 5 个 | 动画片段 |
| `assets/pet/manifest.json`、`assets/pet/anims/manifest.json` | 2 份 JSON | 图片与动画清单 |

共 20 个文件。逐文件来源与校验信息见 [ASSET-INVENTORY.json](ASSET-INVENTORY.json)。不收录 `assets/source/` 源图、WebP、ICO 或截图，也不发布预构建 `.app` / DMG。

上游图片清单把源图标记为 `sheet-threeview.png`，动画清单的来源标记为 `wechat-2026-10`。这些是上游记录的来源标记，源图和视频参考本身未收录。

仓库保留上游 [MIT 许可全文](../LICENSE)；所核对的上游许可未单独排除这些媒体。原始用户提供设计稿及视频参考的独立权属尚未核实，不作独立权属担保，也不代表 Anthropic 的官方授权或认可。详见 [NOTICE](../NOTICE.md)。

## 可选的原创几何回退

```sh
npm run assets
```

此命令运行 `scripts/generate-placeholder.py`。检测到 `assets/pet/front.png` 时会保留现有素材包，不覆盖它；正常检出本仓库后因此继续使用已收录的人物与动画。

若要使用几何占位外观，可先把整个 `assets/pet/` 移到本地备份位置，再运行该命令。生成器只用 Python 标准库在空素材目录生成原创几何角色 PNG，不联网下载、不仿制上游人物，也不生成上游 WebM 动画。占位立绘为 192 × 256，表情为 64 × 64；生成器源码及其原创输出按 MIT 提供。

`npm start` 和本地打包流程会执行同样的素材检查。切换素材时请保留完整目录，包括对应动画清单；恢复备份后再次运行即可使用原包。

## 本地替换

透明 PNG 的命名、表情布局和动画清单格式以现有素材及 `src/renderer/pet.js` 为准。替换为自己的外观时，请保存原素材备份和新素材的来源记录；不要混用不匹配的图片与动画清单。项目不会自动抓取其他素材。

自行加入的第三方素材仍保留其原有许可条款；本项目的 MIT 文件不会自动改变这些条款。
