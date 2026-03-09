# Discord Codex Bridge

一个独立的小项目，用来把 Discord 指令桥接到本地的 Codex 工作流。

当前默认模式不是直接拉起本地 `codex.exe`，而是更稳的 `queue` 模式：
- Discord 里的任务会被写入 `bridge-data/inbox/`
- 你可以让 Codex、人或者后续 runner 处理这个任务
- 处理结果写入 `bridge-data/outbox/<jobId>.md`
- 机器人会自动把结果回发到原来的 Discord 频道

之所以先这么做，是因为这台机器上的 WindowsApps 版 `codex.exe` 目前无法从普通 shell 直接启动。

## 功能

- `!codex <任务>`: 创建一个新任务
- `!codex status`: 查看最近任务状态
- `!codex help`: 查看帮助
- `npm run reply -- <jobId> <文本>`: 从本机直接给某个任务写回结果

## 目录

```text
discord-codex-bridge/
  bridge-data/
    inbox/     # Discord 发来的任务 markdown
    outbox/    # 待回传到 Discord 的结果 markdown
    archive/   # 已处理的结果
    jobs/      # 任务元数据 json
    logs/      # bot 运行日志和 pid
  src/
```

## 启动

1. 复制 `.env.example` 为 `.env`
2. 填好 Discord bot token
3. 保持 `RUNNER_MODE=queue`
4. 安装依赖并启动

```powershell
cmd /c npm.cmd install
cmd /c npm.cmd start
```

如果你想在 Windows 上常驻运行，直接用项目自带脚本：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-bridge.ps1
```

停止：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\stop-bridge.ps1
```

## Discord 工作流

在 Discord 里发：

```text
!codex 帮我检查 D:\codex 里最近改动有没有明显 bug
```

机器人会返回一个 `jobId`，同时在本地生成：

- `bridge-data/jobs/<jobId>.json`
- `bridge-data/inbox/<jobId>.md`

处理完之后，你可以在本机执行：

```powershell
cmd /c npm.cmd run reply -- <jobId> "任务做完了，结果如下……"
```

或者直接创建文件：

```text
bridge-data/outbox/<jobId>.md
```

机器人会自动回发到 Discord，并把结果归档。

## 可选 OpenAI runner

如果你只是想让 bot 直接回一段模型文本，而不是驱动本地 Codex 工作流，可以把：

```text
RUNNER_MODE=openai
```

同时配置：

- `OPENAI_API_KEY`
- `OPENAI_MODEL`

这个模式更像“问答助手”，不是“本地代码代理”。
