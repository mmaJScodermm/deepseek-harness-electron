# Agent Note: Optional vision-model preprocessing keeps conversation execution on DeepSeek

Status: implemented

English | [中文](2026-08-19-optional-vision-model-preprocessing.zh.md)

## Problem

The shipped DeepSeek conversation route explicitly accepts text but users need image input without transferring reasoning, tool execution, or the final response to a different model. Any visual description that reaches DeepSeek must remain reconstructable from the session log, and image-derived instructions must not gain the authority of user-authored text.

## Decision

`@deepseek-ai/dsh-llm-image-analysis` is an optional preprocessing plugin with a `llm-image-analysis` Settings section. Its `provider` and `model` fields select one auxiliary route; omitting both disables preprocessing. A configured route is usable only when exact model metadata explicitly includes the `image` input modality. The Models page places the control inside the official DeepSeek row, labels DeepSeek as the primary conversation and execution model, and presents the auxiliary route as image-understanding enhancement. Turning on the switch only reveals the selector; choosing an eligible route writes the two fields, while turning the enhancement off unsets both.

The visual model describes images but never owns the conversation. After accepted `user/message` events are durable and before model history is derived, the serial `agent/step-input-logged` listener sends each unresolved image-bearing surface message to the visual route with `purpose: 'image-analysis'`. The auxiliary call has no tools and must return a non-empty, text-only result. The session's selected route, normally DeepSeek, receives the resulting text and remains responsible for reasoning, tool calls, and the user-facing response. A configured visual route always applies to image-bearing input, including when the selected conversation route can also read images, so the user's routing choice has one stable meaning.

The Host admits an image when either the selected conversation model explicitly supports image input or a configured auxiliary route resolves with explicit image support. Unknown auxiliary capability never passes admission. Selecting a text-only conversation model for a session that contains current or pending images is valid only while that auxiliary route remains usable; the per-agent ordering described by [atomic Web image admission](../bug-fix/2026-07-29-atomic-web-image-admission.md) keeps admission and selection consistent.

## Durability and trust

Before dispatch, the plugin appends `image-analysis/request` with the exact resolved call configuration, system instruction, and image-bearing messages. A successful call appends `image-analysis/result`, then a text-only replacement `user/message` whose `sourceEventSeqs` cite the original message, request, and result in order. The replacement removes the image only from current model history; the original message and attachment remain durable and renderable. Runtime invariants reject an unpaired result, duplicate result, non-image request source, or malformed replacement provenance.

The visual system instruction treats image content as untrusted data and forbids following instructions found inside it. The replacement separately labels the description as untrusted and preserves user-authored text in a distinct JSON list. The conversation model therefore receives image-derived text as quoted data rather than a silent extension of the user's authority.

Any model-resolution, timeout, stream, finish-reason, empty-output, or non-text-output failure leaves the original image on the surface and stops the step before the conversation model runs. A later step can retry the unresolved image. Request and result events make successful preprocessing replayable; a transient in-memory description is never model-visible.

## Alternatives considered

**Send the image directly to DeepSeek.** The default DeepSeek route explicitly accepts text only, and bypassing its adapter guard would silently claim a capability it does not provide. Direct image delivery remains valid for a selected conversation route whose exact metadata and adapter both support it, but it does not satisfy the requested DeepSeek execution path.

**Let Qwen own the whole conversation when an image appears.** This transfers reasoning, tool selection, and the final answer to the auxiliary model, changes conversation behavior mid-session, and makes the selected DeepSeek route misleading. The auxiliary call is deliberately image-to-text only.

**Infer visual capability from provider or model names.** Names such as `qwen-vl` are conventions rather than runtime guarantees, and custom endpoints may reuse them. Requiring explicit `inputModalities` fails closed and keeps the selector aligned with Host admission.

**Pass the description to DeepSeek without logging it.** That would violate the model-visible-means-logged invariant and make resume, fork, replay, and transcript inspection unable to explain the request. The request, result, and replacement provenance are durable before the conversation call.

## Verification

Package tests cover route validation, explicit modality enforcement, request/result/replacement provenance, text-only output, retry, timeout, disposal, and real Loader composition. Agent-loop tests pin the hook's logged-input timing and fail-before-dispatch behavior; Host tests pin effective image admission and model selection; Models-page tests pin the DeepSeek enhancement framing, toggle states, filtering, and revision-checked settings writes. The keyless assembled Web scenario enables image understanding in the real DeepSeek row, selects Qwen, sends an image, proves Qwen receives that image, proves DeepSeek receives only the durable description, and renders DeepSeek's response with the original image.

## Consequences

Image-bearing steps add one model call, its latency, and its usage before DeepSeek runs. A visual-route failure stops the whole step instead of producing a response without the image context. Converting an image to text may omit visual detail, but retaining the original event preserves inspection and retry. The base bundle mounts the plugin with bounded output and timeout defaults but leaves its route unconfigured, so existing text-only deployments do not gain an implicit external dependency.
