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
