# 渠道隔离升级测试补充

本补充记录渠道升级边界，沿用已审定的前端验收剧本。

- Native 升级：使用父 a2394386 生成的合成会话、凭据及 provider 配置，覆盖导入、空白、失败重试和重启；确认原件保留、三个渠道使用独立数据。
- WSL 后端升级后不会自动导入旧会话，原数据仍在原位置。隔离启动只在新的渠道/profile 根创建目录，不删除或覆盖旧共享数据。旧数据导入为下一批 P2，不能把新根空白视为原数据已丢失或迁移成功。
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

### Windows Beta gate 的 K63 构建例外

仅允许精确 main 的 test 最新 attempt 唯一 scrollback 段 exit=132 / signal=SIGILL 且缺实际 XML；该 attempt 的 job、官方附件 SHA256、完整源文件 plan 与 results、其余段零断言失败都须通过，typecheck 必须真实成功。不匹配日志文本，不改变 test 工作流、Bun 或 scrollback 测试。构建输出及 ci-gate.json/notes 记录“K63 例外已应用”、test run id、attempt 和缺口例数，原 CI failure 不改绿。

合入后可由失败 test 的 workflow_run 触发，或由评估执行 windows-beta workflow_dispatch：approved_sha=<当前已审 main 完整 SHA>、build_only=true；该入口只构建，不需要 artifact_run/approval_ref。不得再次重跑同一 test 凑绿。普通 dispatch 的 build_only 默认为 false，仍走发布入口：本例外不会放行 publish 的失败 test，且原精确产物审核、手动 dispatch 与 beta-publish 环境审批继续生效。

本地回归从 desktop-app 包运行 bun test scripts/beta-ci.test.ts scripts/beta-release.test.ts，设置本会话隔离 ZAOVRA_BETA_TEST_DIR、HOME/XDG/TEMP，ZIP 读取回归使用 Python 3（Windows 可设 PYTHON=python）。
