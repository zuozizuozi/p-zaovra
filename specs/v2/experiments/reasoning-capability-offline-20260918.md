# 模型推理档位：离线核查

日期：2026-09-18。用户选择仅做本地分析；未获准开展付费模型实验。
模型 API 请求 0 次，付费模型 Token 消耗 0。未修改产品实现或 UI；B、C 仍在待办。

## 已执行

- `packages/core`: `bun test test/session-runner-model.test.ts --timeout 30000 --only-failures`：25 项通过。
- `packages/llm`: `bun test test/provider/openai-chat.test.ts --timeout 30000 --only-failures`：31 项通过。
- `packages/llm`: `bun run script/reasoning-options-offline.ts`：7 个请求准备场景；生成最终 HTTP 请求体但不发送，使用 offline.invalid 和无凭证配置。

所有场景使用完全相同的提示，未注入 think harder 等文字。

| 场景                                          | 离线结果                                |
| --------------------------------------------- | --------------------------------------- |
| 未指定档位                                    | 最终请求不含 reasoning_effort           |
| providerOptions.openai.reasoningEffort=low    | 最终请求含 reasoning_effort=low         |
| providerOptions.openai.reasoningEffort=high   | 最终请求含 reasoning_effort=high        |
| providerOptions.openai.reasoningEffort=max    | OpenAI Chat 校验在本地拒绝              |
| 模型变体使用的 http.body.reasoning_effort=max | 最终请求含 reasoning_effort=max         |
| http.body.thinking={type:disabled}            | 协议字段覆盖保护在本地拒绝              |
| 模型输出元数据 16384，请求 maxTokens=32768    | 最终请求含 max_tokens=32768；未自动钳制 |

最后一项修正此前的风险判断：元数据和请求额度确实应该分开理解，但本地链路目前并不以输出元数据强制阻止更大的请求。不能声称更大请求一定被本地能力上限挡住。

## 代码定位与结论

- `packages/llm/src/protocols/openai-compatible-chat.ts`：复用 OpenAI Chat 协议。
- `packages/llm/src/protocols/utils/openai-options.ts`：OpenAI 档位列表排除 max；该规则也进入 compatible 路径。
- `packages/core/src/session/runner/model.ts`：支持模型变体的 body/header 合并，已有配置基础，不需要另起一套模型选择系统。
- `packages/llm/src/route/transport/http.ts`：thinking 属于禁止原始覆盖的协议字段；不能为支持一种模型而解除所有协议字段保护。
- `packages/schema/src/model.ts`：现有能力包括 tools/input/output，没有结构化的推理控制能力；variants 是配置，不等于服务端支持证明。

请求能正确构造，只证明本地参数映射。HTTP 200 也不能单独证明服务端实际执行了档位；网关可能忽略参数。离线阶段无法验证这一点，也无法判定昨日两次推理耗尽在新设置下是否恢复。

## 建议设计（未实施）

1. 以具体 Provider、端点、协议、模型及必要版本信息识别能力，不能只凭模型名称包含 deepseek，或接口标记 openai-compatible，就启用所有档位。
2. 能力信息区分：未知、不支持、支持开关、支持枚举档位、支持数字推理预算。保留声明来源、映射参数及已验证范围。
3. 已知能力显示对应选项；未知模型默认使用 Provider 默认，不生成假的低/中/高。允许显式高级配置，但标记为未验证。
4. 由 Provider 适配层把所选能力转换为真实字段；沿用现有模型变体和 Session 选择链路。不能用系统提示替代接口参数，也不能把 max 默认映射成 high。
5. 输出额度与推理档位分别展示和处理；增加额度仍应考虑上下文余量、服务端能力和用户硬上限。切换档位按后续请求边界生效，并记录最终发送值。

## 付费验证暂缓

待另行授权，再验证第三方网关对参数的接受及实际行为，以及两个失败前缀的 16K/32K/64K 和 low 对照。离线报告不包含交付率提升结论，也不替代完整游戏验收。
