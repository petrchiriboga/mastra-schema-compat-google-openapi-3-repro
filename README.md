# Repro: `@mastra/schema-compat` `GoogleSchemaCompatLayer` emits `oneOf` for `z.discriminatedUnion`, silently breaking Gemini REST tool calls

Minimal reproduction for a bug in [`@mastra/schema-compat@1.2.10`](https://www.npmjs.com/package/@mastra/schema-compat): `GoogleSchemaCompatLayer` emits `oneOf` for `z.discriminatedUnion(...)` tool input schemas. **Gemini REST silently mis-fills tool arguments against `oneOf` schemas** — the model picks the wrong discriminator field name, the wrong field names, and the wrong types, and the AI SDK's runtime validator rejects the result. The customer-visible failure is: `finishReason: tool-calls` but `execute()` never runs.

The layer also emits other JSON Schema 2020-12 keywords (`$schema`, root `additionalProperties: false`, `propertyNames`, sub-schema `additionalProperties`, `anyOf` with `{type:'null'}` branches) that are not part of Google's declared OpenAPI 3.0 `Schema` Object. These are tolerated by REST tool-calling today but rejected by Gemini Live's stricter WebSocket setup validator (see [mastra-ai/mastra#17020](https://github.com/mastra-ai/mastra/issues/17020) verdict table) — which is why PR #17023 needs a downstream sanitizer.

This repro covers both: a static script that proves what the layer emits, and a live REST probe that proves what Gemini actually does with each shape.

## Related issues / PRs

- **[#17020](https://github.com/mastra-ai/mastra/issues/17020)** — original Gemini Live failure (different bug at a different layer; the wire-probe table in its comment is the Live-side evidence)
- **[PR #17023](https://github.com/mastra-ai/mastra/pull/17023)** — voice-package converter swap; needs a downstream sanitizer because the canonical layer produces out-of-spec output (the architectural overlap with this issue)
- **[#17051](https://github.com/mastra-ai/mastra/issues/17051) / [PR #17052](https://github.com/mastra-ai/mastra/pull/17052)** — sibling architectural-cleanup pattern (`z.record` patch path in the same package)

## Run

### Static (no API key required)

```bash
pnpm install
pnpm repro
```

Instantiates `GoogleSchemaCompatLayer` against `gemini-2.5-pro` and dumps `processToJSONSchema` + `processToAISDKSchema.jsonSchema` output for six representative Zod shapes (literal, union, discriminatedUnion, nullable, record, plain object), flagging every key Gemini Live would reject.

### Live REST probe (requires `GOOGLE_GENERATIVE_AI_API_KEY`)

```bash
GOOGLE_GENERATIVE_AI_API_KEY=... pnpm repro:rest
PROBE_MODEL=gemini-2.5-pro GOOGLE_GENERATIVE_AI_API_KEY=... pnpm repro:rest   # default is gemini-2.5-flash
```

Runs four schema cases through actual `generateText` against the chosen Gemini model and reports PASS/FAIL based on whether the model's tool args validate against the original Zod schema. Cost: ~4 short tool-call generations.

## Empirical findings

| Schema feature | gemini-2.5-flash | gemini-2.5-pro |
|---|---|---|
| `z.literal(...)` → standalone string `const` | ✅ PASS | ✅ PASS |
| `z.discriminatedUnion(...)` → `oneOf` + `const` | ❌ **FAIL** | ❌ **FAIL** |
| `z.union([z.object(...), z.object(...)])` → `anyOf` + `const` (control) | ✅ PASS | ✅ PASS |
| `z.record(z.string(), z.boolean())` → `propertyNames` + sub-schema `additionalProperties` | ✅ PASS | ✅ PASS |

The `anyOf` control case has the **same union semantics** as the discriminated-union case (literal-tagged objects of the same shape). Only the JSON Schema keyword changes (`anyOf` vs. `oneOf`) — proving the failure is the `oneOf` keyword specifically, not the union semantics.

### Raw failure capture (flash, discriminated union case)

```jsonc
{
  "type": "tool-call",
  "toolName": "myTool",
  "input": { "shape": { "radius": "5cm", "type": "circle" } },  // ← model output
  "invalid": true,
  "error": {
    "name": "AI_InvalidToolInputError",
    "cause": {
      "name": "ZodError",
      "message": "invalid_union: No matching discriminator. discriminator: \"kind\", path: [\"shape\",\"kind\"]"
    },
    "toolInput": "{\"shape\":{\"radius\":\"5cm\",\"type\":\"circle\"}}"
  }
}
```

The schema declared `kind: "circle"|"square"` (the discriminator) and `r: number`. The model produced `type: "circle"` and `radius: "5cm"` — completely ignored the discriminator name and field names from the `oneOf` schema. The AI SDK catches it; the user's `execute()` never runs.

## Root cause + suggested fix

All in [`packages/schema-compat/src/provider-compats/google.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/schema-compat/src/provider-compats/google.ts):

1. **Override `defaultObjectHandler`** (or unset `additionalProperties` in `preProcessJSONNode` after the super call) so Google object schemas don't default to `additionalProperties: false` — that's an OpenAI-strict-mode convention inherited from [`schema-compatibility.ts:391-395`](https://github.com/mastra-ai/mastra/blob/main/packages/schema-compat/src/schema-compatibility.ts#L391-L395). OpenAPI 3.0 has no `additionalProperties`.
2. **In `postProcessJSONNode`**, recursively strip / rewrite the non-keys: `delete $schema`, `delete propertyNames`, `delete additionalProperties` (sub-schema form), `oneOf → anyOf` (**the load-bearing REST correctness fix**), string-`const → enum: [const]`.
3. **Apply `fixAISDKNullableUnionTypes`'s null-branch collapse to the `processToJSONSchema` path** so the bare JSON Schema output also gets `anyOf: [X, {type:'null'}]` → `{type:'X', nullable:true}`. Today the collapse only runs on `processToAISDKSchema`.

After this, the downstream sanitizer added by [PR #17023](https://github.com/mastra-ai/mastra/pull/17023) (`voice/google-gemini-live-api/src/gemini-schema-sanitizer.ts`) becomes unnecessary.

### Risk

Google's REST `generateContent` structured-output path may quietly depend on `additionalProperties: false` being present (it's the OpenAI strict-mode convention; some Gemini structured-output validators may follow similar semantics). The fix needs to be verified against `google.e2e.test.ts` and any structured-output e2e in `packages/schema-compat/` before merging.

## Environment

- `@mastra/schema-compat@1.2.10` (current latest published)
- `zod@4.3.6`
- `@ai-sdk/google@2.0.74`
- `ai@5.0.192`
- Models confirmed affected: `gemini-2.5-flash`, `gemini-2.5-pro`
- Node.js v22.13+ or v24
- macOS / Linux / Windows — no platform-specific behavior
