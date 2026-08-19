# llm/ — LLM 能力家族

[English](README.md) | 中文

LLM（大语言模型）seam 及其提供方适配器。`llm` 包同时承担 Service Definition 和 Consumer 角色：抽象服务、内容块词汇和流式分片组装器。提供方适配器注册到 `ctx.llm`。这些全是**产品**包。

| 包 | 职责 | ctx key |
|---|---|---|
| [`llm/`](llm/README.md) | LLM 服务和共享流式词汇 | `ctx.llm` |
| [`llm-image-analysis/`](llm-image-analysis/README.md) | 为另一对话模型提供可选的图片转文本预处理 | `ctx.imageAnalysis` |
| [`token-meter/`](token-meter/README.md) | 可感知回放的 token 测量 | `ctx.tokenMeter` |
| [`llm-retry/`](llm-retry/README.md) | 提供方作用域的重试策略 | 监听 `agent/request-error` |
| [`llm-deepseek/`](llm-deepseek/README.md) | 直接 DeepSeek 适配器 | 注册到 `ctx.llm` |
| [`llm-pi-ai/`](llm-pi-ai/README.md) | 多提供方 pi-ai 适配器 | 注册到 `ctx.llm` |

适配器在 seam 上注册提供方路由；重试、token 测量与可选图片分析仍是独立消费方。图片分析把包含图片的持久 user 消息转换为带日志记录的文本替代消息，交给 DeepSeek 等对话模型；它不会把对话或工具执行权转给视觉模型。子 README 负责路由、元数据、回放和提供方协议细节；[LLM 架构决策](../../.agents/notes/implemented/architecture/2026-06-13-twin-llm-adapters.md)说明适配器设计原理。

子系统参考——消息与内容块、模型请求、`StreamChunk` 协议、适配器约定（adapter contract）——见 [docs/subsystems/llm-streaming.md](../../docs/subsystems/llm-streaming.md)（token 计量：[token-meter.md](../../docs/subsystems/token-meter.md)）；另见[孪生适配器](../../.agents/notes/implemented/architecture/2026-06-13-twin-llm-adapters.md)、[回放 token 计量](../../.agents/notes/implemented/architecture/2026-07-15-replay-token-meter-service.md)与[按路由模型上下文](../../.agents/notes/implemented/architecture/2026-07-20-routed-model-context-and-compaction-policy.md) Agent Note。
