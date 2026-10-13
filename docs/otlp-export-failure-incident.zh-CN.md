# Litefuse 上报失败导致 OpenClaw 进程退出

修复已于 2026 年 10 月 12 日合入 `main`，合并提交为 `da51304`。这次修复只修改 OpenClaw 插件，不修改 Litefuse 服务端。

## 术语

| 术语 | 含义 |
| --- | --- |
| 插件 | `openclaw-litefuse-plugin`，运行在 OpenClaw 进程中。 |
| OTLP 上报 | 插件按 OpenTelemetry Protocol（OTLP）向 Litefuse 服务端发送追踪数据。 |
| 上报失败 | OTLP 接口返回非 2xx 状态，或连接中断、请求超时。 |

## 问题场景与触发因素

**旧版插件可能让 OpenClaw 进程退出。** OpenClaw 完成一次代理运行后，插件把追踪数据发到 `<baseUrl>/api/public/otel/v1/traces`。如果 OTLP 请求收到 HTTP 502，客户环境中的 OpenClaw 会记录未处理的 Promise 拒绝，随后退出。

客户日志中的错误为 `OTLP export failed: HTTP 502`，堆栈指向 `src/otlp-exporter.ts`。日志随后出现 `[openclaw] Unhandled promise rejection`。连接重置和请求超时也能触发上报失败；本次模拟测试覆盖了连接重置。

**客户日志与最小复现属于同一条故障路径。** 测试用本地 HTTP 服务模拟 502，并在独立 Node.js 子进程中调用插件的 OpenClaw 钩子。旧版子进程因 `ERR_UNHANDLED_REJECTION` 以退出码 1 结束。测试未启动完整的 OpenClaw 网关，因此日志格式与客户日志不同。

## 根因

1. OTLP 请求收到 502 后，`src/otlp-exporter.ts` 将 `OTLP export failed: HTTP 502` 交给 OpenTelemetry 导出回调。
2. OpenTelemetry 将导出失败传给 `forceFlush()`。旧版 `LitefuseExporter.forceFlush()` 没有捕获拒绝。
3. `agent_end` 钩子用 `setTimeout` 延迟结束追踪数据。旧版延迟回调是没有异常捕获的异步函数，因此上报失败变成未处理的 Promise 拒绝。

HTTP 502 先导致上报失败。插件随后没有捕获异步拒绝，OpenClaw 进程因此退出。`agent_end` 的直接刷新路径和 `gateway_stop` 的关闭路径也可能把导出失败传给 OpenClaw。

## 解决方案与验证

**修复后的插件记录上报失败，并让 OpenClaw 继续运行。** `LitefuseExporter.forceFlush()` 和 `LitefuseExporter.shutdown()` 捕获导出异常。`agent_end` 的延迟回调捕获其他异步异常。插件用警告日志报告错误；同一错误在 60 秒内重复出现时，插件抑制重复日志。一次上报成功后，再次出现的错误会重新记录。

**服务端故障期间的追踪数据仍可能缺失。** 插件修复不会让 HTTP 502 请求成功。插件没有为失败的请求提供持久化补发。Litefuse 服务端恢复后，新产生的追踪数据可以继续上报。

2026 年 10 月 13 日，使用 Node.js 24.14.1 和本地模拟 OTLP 接口验证：旧版提交 `38cb893` 在 502 场景下退出码为 1；修复版的 7 项测试全部通过。测试覆盖 HTTP 502、连接重置、正常返回、失败后恢复、直接刷新，以及重复错误日志。测试通过插件钩子模拟 OpenClaw 调用，未覆盖客户环境中的完整网关。

## 部署更新

以下步骤适用于从 GitHub 克隆到 `~/.openclaw/extensions/openclaw-litefuse-plugin` 的安装。执行前，确认当前分支为 `main`，且 `git status --short` 没有输出。如果目录有本地修改，先保存修改，再更新。

**警告：** 选择允许网关重启的时段。`openclaw gateway restart` 会中断当前网关连接。

1. 进入插件目录：`cd ~/.openclaw/extensions/openclaw-litefuse-plugin`。
2. 检查当前分支：`git branch --show-current`。
3. 检查本地修改：`git status --short`。
4. 拉取修复：`git pull --ff-only origin main`。
5. 安装依赖：`npm ci`。
6. 运行模拟测试：`npm test`。
7. 确认当前提交包含修复：`git merge-base --is-ancestor da51304 HEAD`。命令退出码为 0 表示已包含修复。
8. 重启 OpenClaw 网关：`openclaw gateway restart`。

更新后，发送一次正常的代理请求，并检查 Litefuse 是否收到新的追踪数据。如果 Litefuse 服务端仍返回 502，插件应记录 `[Litefuse] Trace export failed: OTLP export failed: HTTP 502`；OpenClaw 不应再因这次上报失败退出。

### 通过 OpenClaw 或 npm 更新

**手工 Git 安装应使用上面的 `git pull` 步骤。** `openclaw update` 更新 OpenClaw，并维护它记录的插件安装。`openclaw plugins update` 只更新 OpenClaw 记录的插件安装。先运行 `openclaw plugins inspect openclaw-litefuse-plugin`，检查安装来源。如果扩展目录是手工克隆的 Git 仓库，且 OpenClaw 没有该插件的安装记录，这两个命令不会拉取仓库中的修复。目录内的 `npm update` 只更新依赖，不更新仓库中的插件源码。

OpenClaw 也能记录由 `openclaw plugins install git:github.com/litefuse/openclaw-litefuse-plugin@main` 安装的 Git 插件，并用 `openclaw plugins update` 更新它。但当前仓库没有提交 `dist/index.js`。OpenClaw 的 Git 安装不会运行构建脚本，所以这条路径应先在 Git 仓库中提供编译后的入口。

**公共 npm 仓库已提供 `0.3.0`。** 2026 年 10 月 13 日，`openclaw-litefuse-plugin@0.3.0` 发布到公共 npm 仓库，`latest` 指向该版本。主仓库原有的 `0.2.0` 打包配置不会把 `dist/index.js` 放入 npm 包，因此不能直接用于 OpenClaw 托管安装。

`0.3.0` 的[打包 PR](https://github.com/litefuse/openclaw-litefuse-plugin/pull/3) 已于 2026 年 10 月 13 日合入 `main`。发布文件包含 `dist`，编译后的入口为 `./dist/index.js`，打包前会自动构建。从合入提交重新运行 `npm test` 后，7 项测试全部通过，打包产物包含编译入口。使用隔离的 OpenClaw 2026.10.2 从公共 npm 仓库安装该包后，`openclaw plugins inspect openclaw-litefuse-plugin --runtime` 显示插件已从 `dist/index.js` 加载，安装记录与插件版本均为 `0.3.0`。

2026 年 10 月 13 日，还用本地 npm 仓库验证了托管升级。测试先安装未固定版本的测试包 `0.2.9`，再把测试包 `0.3.0` 加入同一仓库。`openclaw plugins update openclaw-litefuse-plugin --dry-run` 预报 `0.2.9 → 0.3.0`；正式更新完成后，运行时检查显示插件版本和安装记录均为 `0.3.0`。`0.2.9` 是本地测试版本，不在公共 npm 仓库。测试未启动网关，因此没有验证网关重启后的业务请求。

隔离验证还发现，OpenClaw 2026.10.2 忽略插件现有的 `before_agent_start` 钩子。其他已注册的钩子可加载；代理跨度的完整性还需单独验证。运行时检查还报告 `provenance-invalid`，但插件状态为 `loaded`。新版 OpenClaw 对外部插件的 `llm_input`、`llm_output` 和 `agent_end` 钩子要求设置 `plugins.entries.openclaw-litefuse-plugin.hooks.allowConversationAccess: true`。

#### 首次通过 npm 安装

1. 检查公共版本：`npm view openclaw-litefuse-plugin version`。仓库应返回 `0.3.0` 或更新版本。
2. 安装插件：`openclaw plugins install npm:openclaw-litefuse-plugin`。不指定版本时，安装记录可跟随 npm 的 `latest` 标签。
3. 设置 `plugins.entries.openclaw-litefuse-plugin.hooks.allowConversationAccess: true`，让插件注册对话钩子。
4. 启动或重启网关。
5. 检查加载状态：`openclaw plugins inspect openclaw-litefuse-plugin --runtime`。结果应显示 `Status: loaded`、`Source: .../dist/index.js` 和已安装版本。

如果原插件位于手工克隆的 `~/.openclaw/extensions/openclaw-litefuse-plugin`，先迁移旧目录。不要让旧目录覆盖 npm 安装。

**警告：** 先停止网关，再移动旧插件目录。移动期间，插件不能为网关上报追踪数据。

1. 停止网关：`openclaw gateway stop`。
2. 备份旧插件目录，并把旧目录移到 `~/.openclaw/extensions` 之外。
3. 如果 `plugins.load.paths` 指向旧目录，从 OpenClaw 配置中删除该路径。
4. 安装 npm 包：`openclaw plugins install npm:openclaw-litefuse-plugin`。
5. 启动网关：`openclaw gateway start`。
6. 检查插件来源和版本：`openclaw plugins inspect openclaw-litefuse-plugin --runtime`。

#### 升级已由 OpenClaw 托管的 npm 安装

以下步骤适用于 `openclaw plugins inspect openclaw-litefuse-plugin` 显示 `Install: Source: npm` 的注册表安装。手工 Git 克隆目录应使用本页前面的 `git pull` 步骤。目录内的 `npm update` 只更新依赖，不更新插件源码。

1. 检查公共版本：`npm view openclaw-litefuse-plugin version`。
2. 预览升级：`openclaw plugins update openclaw-litefuse-plugin --dry-run`。
3. 如果预览显示有新版本，停止网关：`openclaw gateway stop`。
4. 更新插件：`openclaw plugins update openclaw-litefuse-plugin`。
5. 启动网关：`openclaw gateway start`。
6. 检查版本和入口：`openclaw plugins inspect openclaw-litefuse-plugin --runtime`。
7. 发送一次代理请求，并确认 Litefuse 收到新的追踪数据。

如果安装记录的 `Spec` 固定了版本，例如 `openclaw-litefuse-plugin@0.3.0`，步骤 2 应改用 `openclaw plugins update openclaw-litefuse-plugin@latest --dry-run`。步骤 4 应改用 `openclaw plugins update openclaw-litefuse-plugin@latest`。更新后，安装记录会跟随 `latest`。如果预览显示已经是最新版本，不必停止或重启网关。

`openclaw update` 也会尝试维护 OpenClaw 记录的 npm 插件，但插件更新失败时，核心更新仍可能成功。单独确认插件版本时，使用 `openclaw plugins inspect openclaw-litefuse-plugin`。

## 参考代码

- [OTLP 导出器](../src/otlp-exporter.ts)
- [上报失败捕获](../src/litefuse-exporter.ts)
- [代理运行结束钩子](../src/index.ts)
- [模拟测试](../test/export-failure.test.js)
- [修复 PR](https://github.com/litefuse/openclaw-litefuse-plugin/pull/2)
- [npm 打包 PR](https://github.com/litefuse/openclaw-litefuse-plugin/pull/3)
- [npm 包](https://www.npmjs.com/package/openclaw-litefuse-plugin)
- [OpenClaw 插件更新说明](https://docs.openclaw.ai/cli/plugins/uninstall-and-update)
- [OpenClaw 插件入口要求](https://docs.openclaw.ai/plugins/sdk-entrypoints/package-entries)
- [OpenClaw Git 安装的依赖行为](https://docs.openclaw.ai/plugins/dependency-resolution)
