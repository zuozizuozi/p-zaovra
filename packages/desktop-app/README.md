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
