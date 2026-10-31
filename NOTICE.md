# 来源与许可说明

## 上游来源与许可

本项目基于 [Mushan08/claude-chan-pet](https://github.com/Mushan08/claude-chan-pet)，上游作者为 **MushanLuo / Mushan08**。

- 基线提交：[7573579a5a7ade4a853c38144f664b3abf11bbba](https://github.com/Mushan08/claude-chan-pet/tree/7573579a5a7ade4a853c38144f664b3abf11bbba)
- 上游版权声明：`Copyright (c) 2026 MushanLuo`
- 上游许可证：[MIT License](LICENSE)，原版权声明及许可全文予以保留。

本公开版本保留上游代码，并收录来自上述提交的 `assets/pet/` 人物 PNG、WebM 动画与 JSON 清单。所核对的上游 MIT 许可证未单独排除这些媒体文件；本仓库保留该许可与来源声明。本次 macOS 适配代码、原创几何占位角色生成器及其原创输出亦按 MIT 许可提供。

原始用户提供设计稿及视频参考的独立权属尚未核实。记录仓库来源和上游许可不代表对其权利链作出独立确认或担保；本项目也不承诺 Anthropic 官方授权或认可。

## 本次收录的素材

本次只收录 `assets/pet/` 中的 20 个文件：`front.png`、`side.png`、`back.png` 与 `face-01.png` 至 `face-10.png`，`anims/` 中的 5 个 WebM，以及 `manifest.json` 和 `anims/manifest.json` 两份清单。逐文件来源与校验信息见 [素材清单](docs/ASSET-INVENTORY.json)。

`assets/source/` 源图、WebP、ICO 和截图未收录。本仓库不发布预构建 `.app` 或 DMG，也没有自动下载其他人物素材的步骤。

`scripts/generate-placeholder.py` 仍可在没有素材包时，用标准库绘制原创简单几何角色与表情；检测到已有 `front.png` 时不会覆盖素材包。该占位角色不复刻上游人物。使用方式见 [ASSETS](docs/ASSETS.md)。

## 名称、依赖与第三方服务

Claude 与 Anthropic 的名称和相关商标属于各自权利人。项目名称仅用于说明兼容对象；本项目不是 Anthropic 官方软件，也不代表其支持、合作或认可。

Electron 及其他依赖遵循各自许可证。源码构建会取得独立的 Electron 运行时；其版权和第三方许可声明应随本地构建产物保留。本仓库的 MIT 文件不取代这些依赖的许可条款。
