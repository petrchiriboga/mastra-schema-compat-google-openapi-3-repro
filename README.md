# Repro: `@mastra/schema-compat` `GoogleSchemaCompatLayer` emits JSON Schema 2020-12, not OpenAPI 3.0

Minimal reproduction for a bug in [`@mastra/schema-compat@1.2.10`](https://www.npmjs.com/package/@mastra/schema-compat): `GoogleSchemaCompatLayer.processToJSONSchema` / `.processToAISDKSchema` return output that retains JSON Schema 2020-12 keywords (`$schema`, `additionalProperties`, `propertyNames`, `oneOf`, `const`, `anyOf` with `{type: 'null'}` branches) that are not part of the OpenAPI 3.0 `Schema` Object — which is the wire shape `@google/genai`'s `FunctionDeclaration.parameters` typedef declares for both `generateContent` (REST) and `BidiGenerateContent` (Live WebSocket).

REST silently tolerates the out-of-spec keys. The Live WebSocket setup validator does not — it rejects each one with `Unknown name "<keyword>"` and closes the connection with code 1007 before `setupComplete`. The wire-probe verdict table is in [mastra-ai/mastra#17020](https://github.com/mastra-ai/mastra/issues/17020).

This is **distinct from [#17020](https://github.com/mastra-ai/mastra/issues/17020)** (the `@mastra/voice-google-gemini-live` hand-rolled-converter bug, fixed by PR #17023). #17020 is about a downstream consumer doing the wrong Zod→JSON-Schema conversion. *This* issue is one level up — the canonical Google compat layer that #17023 routes through still emits JSON Schema 2020-12 shapes that Live cannot accept, which is why #17023 needs a follow-up `sanitizeForGemini` pass. The fix proposed here makes that sanitizer unnecessary.

Also **distinct from [#17051](https://github.com/mastra-ai/mastra/issues/17051)** (`z.record` crash via `applyCompatLayer`, fixed by PR #17052). Same package, same sibling-architectural-cleanup pattern, different bug.

## Run

```bash
pnpm install
pnpm repro
```

No network calls, no API key needed. The repro instantiates `GoogleSchemaCompatLayer` against `gemini-2.5-pro` and dumps `processToJSONSchema` + `processToAISDKSchema.jsonSchema` output for six representative Zod schemas, flagging every key Gemini Live would reject.

## Expected output (current, buggy)

Every case prints at least one Gemini-Live-rejected key. Highlights:

- `z.literal('active')` → `{ "type": "string", "const": "active" }` — `const` rejected
- `z.discriminatedUnion(...)` → `{ "oneOf": [...] }` with `additionalProperties: false` per branch — `oneOf` + `additionalProperties` both rejected
- `z.number().nullable()` → `{ "anyOf": [{"type":"number"}, {"type":"null"}] }` on `processToJSONSchema` — null branch rejected (note: `processToAISDKSchema` correctly collapses this to `{type:"number", nullable:true}`)
- `z.record(z.string(), z.boolean())` → `propertyNames` + sub-schema `additionalProperties` — both rejected
- Every object → `$schema` + root `additionalProperties: false` — both rejected

## Expected output (after fix)

OpenAPI 3.0 Schema Object shape: no `$schema`, no `additionalProperties`, no `propertyNames`, no `oneOf` (use `anyOf`), no `const` (use single-value `enum`), no `{type: 'null'}` branches (use `nullable: true`).

## Root cause + suggested fix

All in [`packages/schema-compat/src/provider-compats/google.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/schema-compat/src/provider-compats/google.ts):

1. **`additionalProperties: false`** is inherited from `SchemaCompatLayer.defaultObjectHandler` ([`schema-compatibility.ts:391-395`](https://github.com/mastra-ai/mastra/blob/main/packages/schema-compat/src/schema-compatibility.ts#L391-L395)) — an OpenAI-strict-mode convention. Override or unset in `preProcessJSONNode`.
2. **`postProcessJSONNode`** should recursively strip / rewrite OpenAPI-3.0-non-keys: `delete $schema`, `delete propertyNames`, `delete additionalProperties` (sub-schema form), `oneOf → anyOf`, string-`const → enum: [const]`.
3. **`fixAISDKNullableUnionTypes`'s null-branch collapse** should also run on the `processToJSONSchema` path so the bare JSON Schema output gets `anyOf: [X, {type:'null'}]` → `{type:'X', nullable:true}`. Today the collapse only runs on `processToAISDKSchema`.

After this, the downstream sanitizer added by [PR #17023](https://github.com/mastra-ai/mastra/pull/17023) (`voice/google-gemini-live-api/src/gemini-schema-sanitizer.ts`) becomes unnecessary.

### Risk

Google's REST `generateContent` structured-output path may quietly depend on `additionalProperties: false` being present (it's the OpenAI strict-mode convention; some Gemini structured-output validators may follow similar semantics). The fix needs to be verified against `google.e2e.test.ts` and any structured-output e2e in `packages/schema-compat/` before merging.

## Environment

- `@mastra/schema-compat@1.2.10` (current latest)
- `zod@4.3.6` (matches monorepo catalog)
- Node.js v22.13+ or v24
- macOS / Linux / Windows — no platform-specific behavior
