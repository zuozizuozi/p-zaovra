# 渠道隔离升级测试补充

本补充记录渠道升级边界，沿用已审定的前端验收剧本。

- Native 升级：使用父 a2394386 生成的合成会话、凭据及 provider 配置，覆盖导入、空白、失败重试和重启；确认原件保留、三个渠道使用独立数据。
- WSL 后端升级后不会自动导入旧会话，原数据仍在原位置。隔离启动只在新的渠道/profile 根创建目录，不删除或覆盖旧共享数据。旧数据导入为下一批 P2，不能把新根空白视为原数据已丢失或迁移成功。
- 当前只发布 Windows Beta；云 Linux UI 测试取消，Linux 新包沙箱验收待有 Linux 发布需求时安排。既有环境准备失败保留，不算产品通过。
- 新 Beta 必须等渠道隔离与 provider 后续修复实际合入 main 后，由发布负责人按精确 main 构建、核 SHA 并安排上传及冒烟；旧 Beta 不复用。

WSL 保留旧数据的说明基于启动脚本及持久化路径的源码核对。本补充不代表已运行真实 WSL 升级、Electron 弹窗或完整安装器升级测试。

## Native 升级回归运行时

必须使用 Node ≥24.15；只在 Node 24.13 通过不算升级验收。Electron 42.3.3 的 Node 模式（`ELECTRON_RUN_AS_NODE=1`）可运行 `--experimental-strip-types --test test-node/backend-upgrade.node.ts test-node/backend-upgrade-regression.node.ts`。仍须显式设置隔离 `ZAOVRA_UPGRADE_TEST_DIR` 和精确 a239 父版 `ZAOVRA_UPGRADE_PARENT_ROOT`，所有输入仅合成数据。回归覆盖 Dev/Prod 的数据+配置、仅配置、仅数据、外部 DB、失败重试/取消/重启、已有和新建的显式 profile、源链接跳过及已有目标拒绝合并；不替代真实安装器升级或 Electron 选择窗口验收。
