# 渠道隔离升级测试补充

本补充记录渠道升级边界，沿用已审定的前端验收剧本。

- Native 升级：使用父 a2394386 生成的合成会话、凭据及 provider 配置，覆盖导入、空白、失败重试和重启；确认原件保留、三个渠道使用独立数据。
- WSL 升级在启动后端前使用 Python 3 标准库（含 SQLite）准备独立 backend：Dev 发现旧数据时选择复制或空白，Prod 复制，Beta 空白；显式 Electron profile 只接自己的旧 WSL profile，不导入共享 home。先私有 stage、在线备份含 WAL/quick_check、最后一次发布数据/配置/完成标记；链接跳过、未完成目标拒绝合并，失败保留原数据和未启用 stage。缺 Python/SQLite 时给出失败原因，不自动安装。
- 当前只发布 Windows Beta；云 Linux UI 测试取消，Linux 新包沙箱验收待有 Linux 发布需求时安排。既有环境准备失败保留，不算产品通过。
- 新 Beta 必须等渠道隔离与 provider 后续修复实际合入 main 后，由发布负责人按精确 main 构建、核 SHA 并安排上传及冒烟；旧 Beta 不复用。

WSL 保留旧数据的说明基于启动脚本及持久化路径的源码核对。本补充不代表已运行真实 WSL 升级、Electron 弹窗或完整安装器升级测试。

## Native 升级回归运行时

必须使用 Node ≥24.15；只在 Node 24.13 通过不算升级验收。Electron 42.3.3 的 Node 模式（`ELECTRON_RUN_AS_NODE=1`）可运行 `--experimental-strip-types --test test-node/backend-upgrade.node.ts test-node/backend-upgrade-regression.node.ts`。仍须显式设置隔离 `ZAOVRA_UPGRADE_TEST_DIR` 和精确 a239 父版 `ZAOVRA_UPGRADE_PARENT_ROOT`，所有输入仅合成数据。回归覆盖 Dev/Prod 的数据+配置、仅配置、仅数据、外部 DB、失败重试/取消/重启、已有和新建的显式 profile、源链接跳过及已有目标拒绝合并；不替代真实安装器升级或 Electron 选择窗口验收。

### Electron Node 的 PowerShell 命令

在专用 PowerShell 进程中，将工作目录切到 `packages/desktop-app`。预先设置三个绝对路径变量：`$ElectronPath` 指向 Electron 42.3.3 的 `electron.exe`；`$CaseRoot` 指向本轮 F 盘会话内尚未使用的合成夹具目录；`$ParentRoot` 指向精确提交 `a23943862386040f1f8a2c2a3cdacf4f0dfa3451` 的独立源码树。当前工作树及父版源码树都需已准备好各自的离线依赖，且 `bun`、`git` 在 PATH 中。该 PowerShell 进程的 HOME、USERPROFILE、XDG\_\*、TEMP/TMP/TMPDIR 也须指向本轮隔离目录，不使用正常用户数据。

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
$env:ZAOVRA_UPGRADE_TEST_DIR = $CaseRoot
$env:ZAOVRA_UPGRADE_PARENT_ROOT = $ParentRoot
& $ElectronPath --experimental-strip-types --test test-node/backend-upgrade.node.ts test-node/backend-upgrade-regression.node.ts
if ($LASTEXITCODE -ne 0) { throw "Native upgrade regression failed" }
```

运行后退出该专用 PowerShell 进程。Electron 在这里仅作为 Node 运行时，不打开应用窗口；测试用例会验证父版 SHA，新增回归还会检查 Node ≥24.15。

当前 CI 的 `bun test`/包测试不会执行 `test-node/*.node.ts`。这 19 项的通过证据来自本地 Electron Node 24.15.0，不能计入远端 Bun CI 的用例数；是否接入 CI 留到下一批。

## 已知限制

Google 原生工具多轮未经真实验证。597唯一真实复测第二轮在本地代理侧出现 URLError Errno 2，未到达工具续轮；599不追加调用，Beta发出后如需复测须另行授权。

### Windows Beta gate 的 K63 窄限例外

仅允许精确 main 的 test 最新 attempt 唯一 scrollback 段 exit=132 / signal=SIGILL 且缺实际 XML；该 attempt 的 job、官方附件 SHA256、完整源文件 plan 与 results、其余段零断言失败都须通过，typecheck 必须真实成功。不匹配日志文本，不改变 test 工作流、Bun 或 scrollback 测试。构建输出及 ci-gate.json/notes 记录“K63 例外已应用”、test run id、attempt 和缺口例数，原 CI failure 不改绿。

合入后可由失败 test 的 workflow_run 触发，或由评估执行 windows-beta workflow_dispatch：approved_sha=<当前已审 main 完整 SHA>、build_only=true；该入口只构建，不需要 artifact_run/approval_ref。不得再次重跑同一 test 凑绿。普通 dispatch 的 build_only 默认为 false，仍走发布入口。按605，publish在环境审批、精确构建身份检查和下载产物后，重新读取同一SHA最新test run/attempt的官方产物并执行同一verifyK63；不能只信任ci-gate.json。新核验的K63标记、test run/attempt、SHA与缺口数必须与ci-gate.json一致，否则拒绝。原手动dispatch、beta-publish用户审批、签名及精确产物审核保留，prod不受影响。

本地回归从 desktop-app 包运行 bun test scripts/beta-ci.test.ts scripts/beta-release.test.ts，设置本会话隔离 ZAOVRA_BETA_TEST_DIR、HOME/XDG/TEMP，ZIP 读取回归使用 Python 3（Windows 可设 PYTHON=python）。

## 609/612/614 下一批离线回归

- `ZAOVRA_BETA_TEST_DIR=<隔离目录> bun test --timeout 30000 scripts/beta-signing.test.ts scripts/beta-ci.test.ts scripts/beta-release.test.ts electron-builder.config.test.ts src/main/wsl/environment.test.ts src/main/wsl/upgrade.test.ts src/main/onboarding-directory.test.ts`（Desktop 包目录）。合成 SQLite WAL、链接、半成品、实际 ASAR/静态嵌套归档，不运行安装器。
- App 包目录：`bun test src/components/updater-action.test.ts ./test-browser/desktop-entry-dom.test.ts`；DOM 是内存 fixture，不是实际 Electron GUI 验收。
- Core 包目录：`bun test --timeout 30000 test/snapshot.test.ts`，实际临时 Git/链接捕获、diff 与选择性恢复。
- CI `unsigned_beta` 默认 false，只有手动 dispatch 可显式 true；自动事件/缺 Azure 不降级。构建和发布策略须与实际包内 Beta/unsigned/sourceSHA 及 installerSHA256 一致，缺字段/错误类型/切换策略拒绝。prod 签名门保留；此路径未在真实 GitHub 执行。
- 审核器从 `github.workflow_sha` 读取；approved_sha 只决定待核源清单/产物身份，发布旧 main 也运行当前审核器。仅仍有效、来源与最新 test run/attempt/K63 一致的官方 artifact 去重，手动 build_only 可受控重建。
- 安装器改 assisted NSIS，显示进度/完成页；默认产品目录为 Zaovra Dev / Zaovra Beta / Zaovra，原跨渠道目录/协议保护保留。尚未进行真实安装/卸载或 WSL 发行版升级，WSL 修改须外审后才合入。
