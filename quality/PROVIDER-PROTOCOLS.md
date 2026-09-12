# 模型预设与三协议连接

## 目录来源与更新

供应商预设来自 Models.dev 开源数据库（https://models.dev/）。当前 ModelsDev 服务已实现启动后台刷新、每 60 分钟刷新、5 分钟缓存新鲜度检查、本地缓存与构建快照回退。同步目录不会自动修改用户已保存的模型允许列表，也不代表账户获得新模型权限。

自动同步的是供应商和模型资料，不是生成任意新协议的可执行适配代码。新协议、鉴权方式或 SDK 行为变化仍需要验证。

## 本轮改动

- 保留供应商预设入口；OpenAI、Anthropic、Google 的 Key 连接继续自动发现模型，保存模型名称及允许列表，减少手填。
- 自定义模型服务明确提供三个协议选项：OpenAI / Chat Completions、Anthropic / Claude、Google / Gemini。
- 三个选项分别保存 @ai-sdk/openai-compatible、@ai-sdk/anthropic、@ai-sdk/google，不再全部使用 OpenAI 兼容适配器。
- 模型发现使用对应的 Authorization Bearer、x-api-key + anthropic-version、x-goog-api-key；保留分页与 Gemini 生成能力筛选。
- Gemini 根地址默认补 /v1beta；Anthropic/OpenAI 默认补 /v1。标准版本路径随协议切换，自定义代理路径保留。
- 切换协议清空旧模型名单及选择；常规请求头由适配器处理，高级自定义请求头仍可使用。
- 中文与英文入口不再写“仅 OpenAI 兼容”，明确说明按照接口协议、而非模型品牌选择。
- 修复空模型数组不能被当成有效配置的问题。

## 验证

- 表单配置单测 6 项通过。
- 模型发现与地址切换测试 6 项通过。
- 三种真实 SDK 到本地 HTTP 服务的请求测试及已有适配器测试共 14 项通过。验证配置迁移、请求路径、鉴权头和响应文本；没有使用真实付费 Key。
- 生产前端回归通过：打开自定义连接、选择三种协议、逐一获取对应模型、清空上一种协议的名单、保留对话草稿；截图已目视检查。
- app-ui / core / desktop-app 类型检查通过，Electron 开发产物构建通过，未制作安装包。
- 三个既有适配器测试在单独加载时触发注册表循环初始化；测试现在先按应用顺序加载供应商注册表，未修改生产适配器初始化逻辑。

## 使用边界

自定义 OpenAI 选项明确为 Chat Completions 兼容协议；官方 OpenAI 预设保留自己的适配逻辑。Anthropic 和 Gemini 原生接口必须选对应协议，不能仅根据模型名字猜协议。

所有社区供应商不等于均已经逐个完成线上付费验收。云平台等专用服务仍沿用各自所需的账户/区域设置。真实账户权限、模型能力和余额由供应商最终校验。

证据：provider-protocol-selector.png、provider-protocol-ui-tests.txt、provider-protocol-runtime-tests.txt、provider-protocol-discovery-tests.txt、provider-protocol-desktop-build.txt。
