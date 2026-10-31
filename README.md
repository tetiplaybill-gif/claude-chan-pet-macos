# Claude Chan Pet · macOS

一个面向 Claude 桌面应用的社区桌宠适配版。支持随 Claude 启动、桌面拖动、本地碎碎念，以及贴在角色旁的账户用量快照小窗。

基于 [Mushan08/claude-chan-pet](https://github.com/Mushan08/claude-chan-pet)，上游作者 **MushanLuo / Mushan08**，基线提交为 [`7573579a5a7ade4a853c38144f664b3abf11bbba`](https://github.com/Mushan08/claude-chan-pet/tree/7573579a5a7ade4a853c38144f664b3abf11bbba)。本项目由社区维护，与 Anthropic 无隶属或官方认可关系。

**此公开版本只提供代码和原创几何占位角色的生成器。** 上游人物图片、PNG、WebM、完整人物动作及其截图均不随仓库分发；其媒体权利尚待确认。运行时会在本地生成简单几何角色，外观不是上游 Claude 娘。参见 [素材说明](docs/ASSETS.md) 与 [NOTICE](NOTICE.md)。

## 功能与边界

- 启用用户级启动联动后，打开或重新激活 Claude 会唤起桌宠；Claude 已运行时也可识别。重复启动保持单实例。
- 单击角色显示或收起额度小窗，小窗随角色移动；拖动结束不会误当作单击；右键打开设置。
- 支持本地预设碎碎念、可用素材的表情切换、位置锁定、漫游、角色大小、显示/隐藏，以及全屏节能。设置面板有完整、紧凑、极简三种模式。
- 额度显示支持用户从官方 Usage 页面手动记录的快照，以及可选的 Claude Code CLI `statusLine` 采样。它不是实时余额查询；无数据时显示 `—`，不会猜测满额。
- 可选匿名检查 Claude Code 官方公开更新，普通更新静默展示。Desktop 发布说明、Code 更新、账户额度重置分别处理。

普通 Desktop Chat 只提供桌面伴随效果，不读取聊天，也不判断回复是否完成。本仓库不安装 Claude hooks，不自动批准权限，不读取登录令牌、Cookie 或钥匙串，也不调用模型 API。

## 从源码运行

当前仅提供源码，不提供预构建 DMG 或 `.app` 下载。

需要 Apple Silicon Mac、Node.js **22.12.0 或更新版本**与 npm、Python 3。打包和启动助手还需要 Xcode Command Line Tools 中的 `swiftc`、`codesign`。Electron 固定为 **45.1.0**，其官方平台基线是 **macOS Ventura 13 及以上**；本项目只在 **macOS 27 / arm64** 开发环境验证，尚未广泛测试其他系统，暂不支持本项目的 Intel 打包流程。[Electron 官方平台说明](https://github.com/electron/electron/blob/v45.1.0/README.md#platform-support)

在仓库根目录执行：

```sh
npm install
npm run assets
npm start
```

`npm install` 安装 npm 依赖；首次使用 Electron 时可能下载其官方运行时。`npm run assets` 用 Python 标准库生成本地占位 PNG，不下载人物素材。`npm start` 也会先生成所需占位素材。[Electron 安装说明](https://www.electronjs.org/docs/latest/tutorial/installation)

## 本地打包与安装

完成 `npm install` 后，显式准备官方 Electron 运行时，再构建：

```sh
npm run runtime:install
npm run build:mac
python3 macos/install-app.py
```

`runtime:install` 运行已安装的固定版本 Electron 包中的官方安装程序；首次使用时会下载运行时。本地打包脚本本身不联网下载。

构建产物位于 `build/ClaudeChanPet.app` 与 `build/ClaudePetLauncher`；应用安装到 `~/Applications/ClaudeChanPet.app`。安装脚本默认拒绝覆盖已有应用；确认需要替换时，先退出旧桌宠，再显式使用 `--backup-existing` 保留备份。构建与应用安装都不会自动启用启动联动或修改 Claude 设置，安装后也不会自行启动应用。可在 Finder 中打开它，或运行：

```sh
open ~/Applications/ClaudeChanPet.app
```

构建脚本也会拒绝覆盖已有 `build/ClaudeChanPet.app`，重建前请先移走旧产物。若已有可信的官方 Electron 45.1.0 arm64 运行时，可显式指定它；例如将其放在自己的 `vendor/` 目录后运行：

```sh
ELECTRON_RUNTIME="$PWD/vendor/Electron.app" npm run build:mac
```

此路径只是示例；构建脚本核验版本、架构与签名，不负责下载运行时。

需要随 Claude 启动时，再显式执行：

```sh
python3 macos/install-launcher.py --enable
```

它注册当前用户的 LaunchAgent，由助手监听 Claude 应用启动与激活；并非只在登录时打开一次桌宠。停用与恢复：

```sh
zsh macos/disable-autostart.sh
zsh macos/enable-autostart.sh
```

使用、可选额度接入、完整撤销步骤见 [USAGE](docs/USAGE.md)。数据位置与网络访问见 [PRIVACY](docs/PRIVACY.md)。

## 开发检查

```sh
npm test
```

JavaScript 与 Python 测试覆盖额度解析和显示、点击与拖动、窗口放置，以及本地桥的输入处理。测试使用合成数据，不需要 Claude 账号或模型请求；真实桌面交互仍需在目标 macOS 环境中手动验证。

## English

A community macOS adaptation of [Mushan08/claude-chan-pet](https://github.com/Mushan08/claude-chan-pet), originally by MushanLuo / Mushan08. It is not affiliated with or endorsed by Anthropic.

This source-only repository includes an original geometric placeholder generator, **not the upstream character artwork or animation media**. Build locally on Apple Silicon with Node.js 22.12.0+, Python 3 and Xcode Command Line Tools. Click the pet to toggle a following quota popup; drag to move; right-click for settings. Claude startup integration and the optional CLI status-line bridge require separate, explicit installation.

Usage-page data is a manual snapshot, not a live balance. The app does not scrape authenticated pages, access credentials, install Claude hooks, or call model APIs. Code and the original generated placeholder are covered by [MIT](LICENSE); uncertain upstream media rights are not granted. See [NOTICE](NOTICE.md), [privacy](docs/PRIVACY.md), and [usage](docs/USAGE.md).
