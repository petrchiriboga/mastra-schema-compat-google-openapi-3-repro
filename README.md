# Repro: `GoogleSchemaCompatLayer` emits `oneOf` for `z.discriminatedUnion`, silently breaking Gemini REST tool calls

Minimal reproduction for a bug in [`@mastra/schema-compat@1.2.10`](https://www.npmjs.com/package/@mastra/schema-compat). `GoogleSchemaCompatLayer` emits `oneOf` for `z.discriminatedUnion(...)` tool input schemas. Gemini REST returns malformed tool args against `oneOf` — wrong discriminator name, wrong field names, wrong types — the AI SDK's runtime validator rejects them as `AI_InvalidToolInputError`, and the user's `execute()` never runs. Same union expressed with `z.union` (which emits `anyOf`) works fine — proving the failure is the `oneOf` keyword specifically.

Reproduced on both `gemini-2.5-flash` and `gemini-2.5-pro`.

The layer also emits other JSON Schema 2020-12 keywords (`$schema`, root `additionalProperties: false`, `propertyNames`, sub-schema `additionalProperties`) that REST tool-calling tolerates today but Gemini Live's setup validator rejects (verdict table: [#17020](https://github.com/mastra-ai/mastra/issues/17020)) — which is why PR #17023 needs a downstream sanitizer.

## Run

```bash
pnpm install
pnpm repro                                                    # layer output only — no API key
GOOGLE_GENERATIVE_AI_API_KEY=... pnpm repro                    # + live REST probe
PROBE_MODEL=gemini-2.5-pro GOOGLE_GENERATIVE_AI_API_KEY=... pnpm repro
```

## Expected output (live mode, abridged)

```
--- live REST: discriminatedUnion ---
AI SDK marked invalid:
  raw model output: {"shape":{"radius":"5cm","type":"circle"}}
  validator error : invalid_union: No matching discriminator. discriminator: "kind"

--- live REST: union ---
execute() received: {"shape":{"kind":"circle","r":5}}
```

Same union semantics, same prompt, same model. Only the schema keyword differs.

## Root cause

[`packages/schema-compat/src/provider-compats/google.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/schema-compat/src/provider-compats/google.ts) passes `oneOf` straight through. Fix is a `oneOf → anyOf` rewrite in `postProcessJSONNode` (plus stripping `$schema`, `propertyNames`, `additionalProperties`, and converting string `const → enum: [const]` for full OpenAPI 3.0 alignment, which makes PR #17023's downstream sanitizer unnecessary).

## Environment

- `@mastra/schema-compat@1.2.10`, `zod@4.3.6`, `@ai-sdk/google@2.0.74`, `ai@5.0.192`
- Models confirmed affected: `gemini-2.5-flash`, `gemini-2.5-pro`
- Node.js ≥ 22
