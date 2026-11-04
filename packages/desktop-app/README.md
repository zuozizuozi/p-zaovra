# Zaovra Desktop

Windows 本地测试：双击本目录唯一的 `启动器.bat`，自动检查依赖和 Electron 运行程序后启动桌面端。

本地开发模式直接进入工作台，不需要官网登录，也不会生成虚假的账户或会员状态。使用自己的模型服务仍需配置相应密钥。正式构建保留账户校验；浏览器版不受此开发模式影响。

## 模型服务配置

- 常见服务商：在设置的“提供商”中选择服务商，选择 API Key 连接并粘贴密钥；沿用预设地址和内置模型目录。默认 OpenAI、Anthropic 和 Google 连接会先请求模型列表检查认证，已有自定义地址或额外认证参数的连接保持原流程。
- 自定义 OpenAI 兼容服务：填写服务地址和 Key，点击“获取模型”，搜索并勾选模型后保存。提供商 ID 和名称自动生成；高级设置可覆盖名称、ID 和请求头。服务根地址默认补 `/v1`，粘贴完整 `/chat/completions` 地址也会转换为基础地址。
- 服务不支持模型列表、使用环境变量密钥或网络失败时，可手动填写模型 ID；模型显示名称留空时使用 ID。
- 获取模型通过桌面主进程发起，15 秒超时，不跟随重定向，也不发起生成请求。模型列表成功不代表模型支持编程、工具调用或账户有可用余额。
- 主进程或预加载接口更新后需重新启动桌面端；只有页面热更新不足以加载新的连接接口。

造物桌面端：Electron 主进程、窗口和系统集成、安装包。工作台界面在 `../app-ui/`，官网在 `../website/app/`。在仓库根目录运行 `bun run dev:desktop`。

The Zaovra Desktop app, built with Electron.

## 渠道隔离升级验收

- Native 正式版首次升级会将原数据库和全局配置复制到本 profile 的独立 backend 目录，原件保留。Dev 发现旧数据时先选择“导入原有数据（复制，原文件保留）”或“从空白开始”；退出不记为完成。
- 数据库使用 SQLite 在线备份，包含已提交的 WAL；数据、配置和完成标记一起启用。失败不会启动空白后端，可以重试。已完成的选择在重启后保持，不重新覆盖新数据。
- 首个 Beta 尚未发布，没有旧 Beta 数据需要自动导入，始终从空白数据开始。显式 `--user-data-dir` 仅检测该 profile 自己的旧数据与配置；已有正式版私有数据会复制升级，新建空 profile 保持空白，不读取共享 home 或环境变量指定的外部来源。
- Native 后端不再继承 `ZAOVRA_DB`、`ZAOVRA_CONFIG`、`ZAOVRA_CONFIG_DIR`、`ZAOVRA_CONFIG_CONTENT` 作为运行时覆盖；原 `ZAOVRA_DB`/配置目录仅可作为上述升级复制的来源。需要另一套数据时使用独立 `--user-data-dir`。本条是渠道隔离的兼容性变更，不影响独立 CLI 的覆盖参数。
- 导入时跳过源目录内的符号链接并记录日志，不跟随链接读取数据库；已存在且没有完成标记的 backend 仍拒绝合并。
- 升级回归必须在 Node ≥24.15（包括 Electron 42.3.3 自带 Node 24.15.0）执行，覆盖数据/配置组合、显式 profile、外部 DB、重试/取消/重启与符号链接。
- 使用父 a2394386 生成合成会话、凭据和 provider 配置，验证导入、空白、失败重试、重启，以及三渠道并装互不影响；另以仍打开的 SQLite WAL 写入器验证在线备份。测试只用独立合成目录。WSL 的真实旧安装迁移、真实安装器升级及 Linux 新包沙箱仍须单独验收。
- WSL 后端首次升级在独立 stage 安全复制：Dev 可选择导入或空白、Prod 导入、Beta 空白，显式 profile 不读取共享旧数据。在线 SQLite 备份含 WAL 并核 quick_check，完成后一次发布 backend 和标记；原数据保留，失败不启用半成品。需要发行版已有 Python 3/SQLite，不自动安装；真实 WSL 升级和安装器仍须独立验收，见[升级测试补充](TESTING.md)。

## Development

```bash
bun install
bun dev
```

## Build

Run the `build` script to build the app's JS assets, then `package` to
bundle the assets as an application. The resulting app will be in `dist/`.

```bash
bun run build && bun run package
```
