# 来源与许可说明

## 上游代码

本项目基于 [Mushan08/claude-chan-pet](https://github.com/Mushan08/claude-chan-pet)，上游作者为 **MushanLuo / Mushan08**。

- 基线提交：[7573579a5a7ade4a853c38144f664b3abf11bbba](https://github.com/Mushan08/claude-chan-pet/tree/7573579a5a7ade4a853c38144f664b3abf11bbba)
- 上游版权声明：`Copyright (c) 2026 MushanLuo`
- 代码许可证：[MIT License](LICENSE)，原版权声明及许可文本予以保留。

本次 macOS 适配代码和原创几何占位角色生成器亦按 MIT 许可提供。MIT 许可仅覆盖有权按该许可提供的代码及本次原创占位素材；不为来源或权利未明确的第三方媒体补充授权。

## 不随仓库分发的媒体

上游人物立绘、表情图片、动画 PNG / WebM 和相关截图的媒体权利尚待确认，因此均不随本公开仓库分发。仓库不包含下载这些素材的自动步骤，也不承诺上游完整人物或动作在本版本中可用。

`scripts/generate-placeholder.py` 只用标准库绘制原创的简单几何角色与表情，不复刻上游人物。生成的 `assets/pet/` 文件留在本地并由 Git 忽略。用户自带素材的使用、修改和再分发权限应由用户自行核实，详见 [ASSETS](docs/ASSETS.md)。

## 名称、依赖与第三方服务

Claude 与 Anthropic 的名称和相关商标属于各自权利人。项目名称仅用于说明兼容对象；本项目不是 Anthropic 官方软件，也不代表其支持、合作或认可。MIT 不授予第三方商标或人物形象权利。

Electron 及其他依赖遵循各自许可证。源码构建会取得独立的 Electron 运行时；其版权和第三方许可声明应随本地构建产物保留。本仓库的 MIT 文件不取代这些依赖的许可条款。
