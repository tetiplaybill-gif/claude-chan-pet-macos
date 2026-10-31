# 隐私与数据流

桌宠在本地运行。普通 Claude Desktop Chat 不向桌宠提供聊天内容或工作状态。默认功能不访问 Claude 登录令牌、钥匙串、Cookie、私人聊天文件或账户 API；不自动登录，不安装 Claude hooks，不调用模型，不产生模型请求费用。

## 本地文件

默认数据目录为 `~/Library/Application Support/ClaudeChanPet/`，包括：

| 文件或目录 | 用途 |
| --- | --- |
| `config.json`、`state.json` | 本地外观、位置与交互设置 |
| `quota.json` | 最近一次用量快照的来源、采集时间、窗口百分比与重置说明 |
| `bridge-status.json`、`usage/` | 可选 CLI 桥的状态、脚本、顺序记录及撤销所需备份 |
| `companion-state.json` | 启动助手提供的全屏节能标记与时间 |
| `notification-ledger.json` | 本地通知与去重记录 |
| `public-updates.json` | 公开更新检查结果与检查时间 |
| `pet.log`、`launcher.log`、`launcher-error.log` | 本地运行与错误诊断 |
| `electron/` | 此桌宠自己的 Electron 运行数据 |

这些文件不会被项目自动上传。日志可能含本机路径和错误细节；分享问题报告前应自行检查。仓库不会提交用户数据、真实额度样本或运行截图。

## 随 Claude 启动与全屏节能

只有用户显式启用启动联动后，助手才会持久运行。它识别 Claude 的应用标识、运行进程及启动/激活事件，并周期性核对应用状态。全屏节能读取前台窗口的几何范围，用于判断是否暂停桌宠动画；不获取窗口标题、屏幕像素或聊天文字，不请求辅助功能或屏幕录制权限。

LaunchAgent 位于 `~/Library/LaunchAgents/io.github.mushan08.claude-chan-pet.launcher.plist`。关闭桌宠不会关闭 Claude 或其会话。撤销见 [USAGE](USAGE.md)。

## 额度来源

**官方页面手动快照：** 用户自行打开 Claude 的 Settings → Usage，确认当前账户后录入页面可见信息。桌宠只显示本地记录，不控制浏览器、不抓取认证页面、不保存登录信息，不定时刷新账户用量。未知日期或时区的重置说明保留原文，不猜测成精确时间。超过十分钟标为旧数据；手动样本不会触发重置提示音。

**可选 Claude Code CLI statusLine：** 显式运行安装脚本会读取 `~/.claude/settings.json`，保存该文件的完整原始备份，并修改其中的 `statusLine`。完整备份可能包含用户自己的敏感设置，请勿上传。备份和桥记录以仅当前用户可读写的权限保存在 `usage/` 中。

桥会收到 CLI 传给 statusLine 的 JSON，并仅把 `rate_limits.five_hour` / `seven_day` 中的 `used_percentage` 和 `resets_at` 保存为额度快照。原始 stdin 不写入磁盘或日志；已有 statusLine 命令会继续收到原始输入，其自身行为由用户原有配置决定。桥不读取凭据，不向 Claude 发起请求，也不会为刷新用量主动运行 Claude。重复的相同采样不会被伪装成新数据。

CLI 数据不证明它与 Desktop 登录了同一账户，也不保证 Desktop Chat 或 Code 标签会调用 CLI 的 statusLine。账户额度、上下文占用、API 费用不是同一种数据；本项目不把 token 估算当作账户余额。

## 网络访问

应用的公开更新开关启用时，启动后及每六小时匿名读取一次 [Claude Code 官方 CHANGELOG](https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md)。用户也可主动点击检查。请求不附带账户标识、认证头或 Cookie，服务端仍会看到常规网络连接信息（例如 IP 地址）。关闭该开关会停止后续自动检查；已发出的请求可能完成。

“Desktop 官方发布说明”按钮只在用户点击时交给系统打开 [Claude Desktop release notes](https://support.claude.com/en/articles/12138966-release-notes)。外部浏览器或系统所用的登录状态由它们管理，桌宠不读取或传递这些凭据。Code 更新内容不表示 Desktop 更新，也不表示账户额度重置。

首次安装依赖和 Electron 运行时会访问 npm / Electron 官方分发源，属于用户执行的构建步骤。运行时没有模型 API 调用、遥测上传或自动素材下载。面板和额度小窗本身禁用网络连接，只通过有限的本地 IPC 读取主进程提供的数据。
