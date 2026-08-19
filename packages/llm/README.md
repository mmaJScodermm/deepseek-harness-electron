# llm/ — LLM capability family

English | [中文](README.zh.md)

The LLM seam and its provider adapters. The `llm` package owns both the Service Definition and Consumer roles: the abstract service, content-block vocabulary, and stream-chunk assembler. Provider adapters register on `ctx.llm`. All **product** packages.

| Package | Role | ctx key |
|---|---|---|
| [`llm/`](llm/README.md) | LLM service and shared streaming vocabulary | `ctx.llm` |
| [`llm-image-analysis/`](llm-image-analysis/README.md) | Optional image-to-text preprocessing for a separate conversation model | `ctx.imageAnalysis` |
| [`token-meter/`](token-meter/README.md) | Replay-aware token measurement | `ctx.tokenMeter` |
| [`llm-retry/`](llm-retry/README.md) | Provider-scoped retry policy | listens to `agent/request-error` |
| [`llm-deepseek/`](llm-deepseek/README.md) | Direct DeepSeek adapter | registers on `ctx.llm` |
| [`llm-pi-ai/`](llm-pi-ai/README.md) | Multi-provider pi-ai adapter | registers on `ctx.llm` |

Adapters register provider routes on the seam; retry, token measurement, and optional image analysis remain separate consumers. Image analysis converts durable image-bearing user messages into logged text replacements for a conversation model such as DeepSeek; it does not transfer conversation or tool ownership to the visual model. The child READMEs own routing, metadata, replay, and provider-wire details; the [LLM architecture decisions](../../.agents/notes/implemented/architecture/2026-06-13-twin-llm-adapters.md) own the adapter rationale.

The subsystem reference — messages and blocks, the model request, the `StreamChunk` protocol, the adapter contract — is [docs/subsystems/llm-streaming.md](../../docs/subsystems/llm-streaming.md) (token measurement: [token-meter.md](../../docs/subsystems/token-meter.md)); see the [twin adapters](../../.agents/notes/implemented/architecture/2026-06-13-twin-llm-adapters.md), [replay token meter](../../.agents/notes/implemented/architecture/2026-07-15-replay-token-meter-service.md), and [routed model context](../../.agents/notes/implemented/architecture/2026-07-20-routed-model-context-and-compaction-policy.md) Agent Notes.
