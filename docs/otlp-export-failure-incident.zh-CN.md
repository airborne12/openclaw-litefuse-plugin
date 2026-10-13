# Litefuse 插件上报失败导致 OpenClaw 退出

## 故障场景

旧版插件在 OpenClaw 完成代理运行后，向 Litefuse 发送 OTLP 追踪数据。如果服务端返回 HTTP 502，客户日志会出现 `OTLP export failed: HTTP 502`，随后出现 `[openclaw] Unhandled promise rejection`，OpenClaw 进程可能退出。连接中断也能触发上报失败。

本地模拟 HTTP 502 时，旧版插件所在的测试进程以退出码 1 结束。客户日志与模拟测试都指向插件的 OTLP 导出路径。

## 根因与修复

OTLP 导出失败会使 `forceFlush()` 拒绝。旧版插件没有捕获这个拒绝；`agent_end` 钩子的延迟异步回调又把它变成未处理的 Promise 拒绝。

修复后的插件捕获上报异常并记录警告。Litefuse 服务端故障期间，追踪数据仍可能缺失，但这类上报失败不会再使 OpenClaw 进程退出。模拟 HTTP 502、连接中断和恢复等场景的 7 项测试已通过。

## 将当前插件升级到修复版

修复已合入 `main`，公共 npm 包从 `0.3.0` 起包含修复。先运行 `openclaw plugins inspect openclaw-litefuse-plugin`，确认客户机器上的安装来源。

**警告：** 选择可中断连接的时段升级。重启网关会中断当前连接。

### 手工克隆的 Git 安装

如果插件位于 `~/.openclaw/extensions/openclaw-litefuse-plugin`，且该目录是手工克隆的 Git 仓库，先保存本地修改，再执行：

```bash
cd ~/.openclaw/extensions/openclaw-litefuse-plugin
git pull --ff-only origin main
npm ci
openclaw gateway restart
```

`npm update` 不会更新这个 Git 仓库中的插件源码。

### OpenClaw 托管的 npm 安装

如果 `openclaw plugins inspect` 显示安装来源为 npm，执行：

```bash
openclaw plugins update openclaw-litefuse-plugin@latest --dry-run
openclaw gateway stop
openclaw plugins update openclaw-litefuse-plugin@latest
openclaw gateway start
```

如果预览显示已是最新版本，不必停止网关。`@latest` 也能解除安装记录中固定的旧版本。手工克隆的 Git 安装应使用上面的 Git 命令。

### 验证

运行 `openclaw plugins inspect openclaw-litefuse-plugin --runtime`。结果应显示 `Status: loaded` 和 `0.3.0` 或更新版本。再发送一次代理请求，检查 Litefuse 是否收到追踪数据。如果服务端仍返回 502，插件应记录上报失败警告；OpenClaw 不应因这次上报失败退出。

- [修复 PR](https://github.com/litefuse/openclaw-litefuse-plugin/pull/2)
- [npm 包](https://www.npmjs.com/package/openclaw-litefuse-plugin)
- [OpenClaw 插件更新说明](https://docs.openclaw.ai/cli/plugins/uninstall-and-update)
