# 使用与撤销

以下命令均在仓库根目录运行。源码依赖、本地构建和安装步骤见 [README](../README.md)。本项目面向 Apple Silicon；不提供预构建应用下载。

## 桌面交互

| 操作 | 效果 |
| --- | --- |
| 单击角色 | 显示或收起额度小窗 |
| 拖动角色 | 移动角色，小窗随动；拖动不触发单击 |
| 右键角色 | 打开完整设置入口 |
| 小窗中的“设置” | 打开设置面板 |
| 小窗中的收起按钮 / Escape | 收起小窗 |
| 托盘菜单 | 找回角色、设置或退出桌宠 |

角色和设置面板独立显示。设置可调整高度、位置锁定、漫游、动画、碎碎念、全屏节能、公开更新与提示音；“回初始位置”用于找回移出可见范围的角色。碎碎念为本地预设文案，不调用模型。占位素材只有简单几何角色与表情，不包含上游完整人物动画。

完整、紧凑和极简模式改变设置面板的信息密度；极简模式保留恢复完整面板的按钮。普通 Chat 的工作状态未连接，桌宠不会读取回复或自动判断任务完成。

## 随 Claude 启动

完成本地构建与应用安装后，显式启用：

```sh
python3 macos/install-launcher.py --enable
```

助手通过用户级 LaunchAgent 运行，识别 Claude 桌面应用的启动、激活及当前运行状态。Claude 已运行时可唤起桌宠；之后重新打开或激活 Claude 也会检查。重复触发不会创建多个桌宠实例。手动退出桌宠后，助手不会在 Claude 状态不变时不断将它重启；重新激活 Claude 可再次唤起。

这不是仅在登录时启动一次桌宠。桌宠与 Claude 分开退出，助手不会关闭 Claude 的会话。

停用联动后仍可手动运行桌宠：

```sh
zsh macos/disable-autostart.sh
```

脚本卸载当前用户的 LaunchAgent，并把 plist 保留为 `.plist.disabled`。需要恢复时执行：

```sh
zsh macos/enable-autostart.sh
```

## 官方 Usage 页的手动快照

用户自行打开 Claude Desktop 的 **Settings → Usage**，确认当前账户，并查看“当前会话 / Current session”和“本周 / This week”的用量。公开版本只接受用户明确提供的页面可见数字与文字；它不会替用户打开认证页面、登录、读取 Cookie 或定时抓取。

页面显示的是**已使用百分比**；桌宠据此计算显示剩余比例。它不换算剩余消息条数、token 数或可用金额。请记录实际观察时刻；不能仅为让旧数据显得新鲜而更新时间。

手动导入器只接收命令参数，不读取页面。先查看用法：

```sh
python3 macos/import-usage-snapshot.py --help
```

确认页面后，把以下引号中的占位文字替换为页面实际值再运行；不要原样运行示意命令：

```sh
python3 macos/import-usage-snapshot.py \
  --five-hour '<当前会话的已用百分比>' \
  --week '<本周的已用百分比>' \
  --five-reset-text '<当前会话的重置说明>' \
  --week-reset-text '<本周的重置说明>'
```

至少提供一个百分比；另一个窗口没有数据就省略对应参数，重置说明也可省略。百分比参数填数字，不附 `%`。默认记录运行时刻，仅适合刚刚查看的页面；导入先前记录时，另传 `--sampled-at '<含 Z 或时区偏移的 ISO 采集时间>'`，保留真正采集时间。

脚本原子写入本地 `quota.json`，不备份历史账户快照；已有更新样本、同时间冲突、损坏文件或链接目标会拒绝覆盖。`--output` 可指定测试文件，默认位置见 [PRIVACY](PRIVACY.md)。手动导入与 CLI 桥使用同一个最近快照文件，后续 CLI 采样可能替换手动快照；界面会显示当前来源，不能把两者当作同一账户的连续测量。

本地格式使用 `source: "claude-official-usage-page"`、`updatedAt` 及 `windows.fiveHour` / `windows.sevenDay`。这两个内部键在官方页面来源下分别显示为“当前会话”和“本周”，不表示当前会话已经开始一个固定计时周期。每个窗口包含：

| 字段 | 含义 |
| --- | --- |
| `usedPercent` | 官方页面实际显示的已使用百分比，缺失时不要补零 |
| `resetsAt` | 已知完整日期、时间和时区时才能填写，否则为 `null` |
| `resetText` | 页面可见的短重置说明，保留原意，不填写 HTML |

星期或“首次消息后开始”不足以确定精确重置时刻，应保留 `resetText`。快照超过十分钟显示“数据较旧”；已知窗口到期后显示等待新数据，不自动变成满额。缺失、解析失败或只提供一个窗口时，缺失部分显示 `—`。手动快照始终静默，不触发账户重置提示音。

## 可选：Claude Code CLI statusLine 桥

**只使用 Claude Desktop 的用户无需安装 CLI 来使用桌宠或手动快照。** 此桥适合已经在终端使用 Claude Code 的用户；不保证 Desktop Chat 或 Desktop Code 标签会执行它，也不验证 CLI 和 Desktop 是否为同一账户。

Claude Code 官方 statusLine 输入可含 `rate_limits.five_hour` / `seven_day` 的使用百分比和重置时间。字段受套餐、环境与会话阶段影响，可能独立缺失，通常要到会话首次 API 响应后才可用；相关官方支持范围见 [rate-limit usage 文档](https://code.claude.com/docs/en/statusline#rate-limit-usage)。桥不会为了取得数据而发送消息或主动触发模型请求。

如决定启用这一持久设置修改，请先阅读 [隐私说明](PRIVACY.md)，再显式运行：

```sh
python3 macos/install-statusline.py
```

该脚本修改 `~/.claude/settings.json` 中的 `statusLine`，在桌宠自己的 `usage/` 目录备份原始设置并保存原命令。已有命令会继续接收原始输入；无关设置予以保留。构建、安装桌宠或启用启动助手均不会自动执行此步骤。脚本拒绝无法安全处理的原设置，而不是强行覆盖。

“Code 桥已配置 · 尚未收到用量采样”只表示设置完成，**不表示已有额度数据**。CLI 没有自然上报、窗口字段缺失或登录账户不一致，都可能使它无法代表 Desktop 用量。不要为了刷新显示而额外发送付费模型请求。

撤销桥：

```sh
python3 macos/uninstall-statusline.py
```

撤销只在当前命令仍匹配本桥时恢复原 `statusLine`，保留其余设置和安装后用户自行改过的命令。安装、撤销都支持 `--settings` 与 `--data-root`；使用自定义路径时，两次必须传入相同路径。备份留在本地，不自动删除。

## 更新和通知

“Claude Code 官方更新”只读取公开 changelog。开关启用时会在启动后及每六小时检查，也可主动点检查；普通功能更新静默展示。Desktop 发布说明按钮打开另一份官方页面。

账户重置、公告和普通发布更新在界面中分别标记。初次样本、重复样本、手动页面快照或倒计时结束都不会当作已确认的账户重置。重置提示音默认关闭；只有支持的采样来源提供新的有效窗口证据时，才可能产生相应提示。

## 撤销安装

1. 若启用了 CLI 桥，先运行 `python3 macos/uninstall-statusline.py`，确认恢复结果。不要先删除 `usage/`，否则会丢失原 statusLine 记录。
2. 若启用了启动联动，运行 `zsh macos/disable-autostart.sh`。
3. 从托盘退出桌宠，再将 `~/Applications/ClaudeChanPet.app` 移到废纸篓。此前安装备份需要保留或恢复时，按安装脚本报告的备份位置处理。
4. 确认不再需要配置和备份后，可自行移除 `~/Library/Application Support/ClaudeChanPet/`，以及 `~/Library/LaunchAgents/io.github.mushan08.claude-chan-pet.launcher.plist.disabled`。先检查其中可能仍需保留的设置备份。
5. 本地源码、`node_modules/` 和 `build/` 可按需删除；这些步骤不删除或重装 Claude 本身。

本地构建应用不是经 Apple 公证的公开发行包。如果系统阻止运行，请先核对来源与构建结果，再自行按 macOS 正常安全流程判断是否允许；项目不提供关闭系统防护或批量移除隔离属性的命令。
