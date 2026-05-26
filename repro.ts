/**
 * Repro for the GoogleSchemaCompatLayer OpenAPI-3.0 bug.
 *
 * Two parts:
 *   1. STATIC — runs always. Dumps the JSON Schema the layer produces for each
 *      Zod shape and flags every key Gemini Live's WebSocket setup validator
 *      rejects (verdict from mastra-ai/mastra#17020).
 *   2. LIVE REST — runs if GOOGLE_GENERATIVE_AI_API_KEY (or GOOGLE_API_KEY) is
 *      set. Calls Gemini REST via @ai-sdk/google with each schema as a tool's
 *      input and reports PASS/FAIL based on whether the model's tool args
 *      validate against the original Zod schema.
 *
 * Cost when live: ~4 short tool-call generations against PROBE_MODEL
 * (default: gemini-2.5-flash; set PROBE_MODEL=gemini-2.5-pro to switch).
 */
import { google } from '@ai-sdk/google';
import { GoogleSchemaCompatLayer } from '@mastra/schema-compat';
import { generateText, stepCountIs } from 'ai';
import { z } from 'zod';

const MODEL_ID = process.env.PROBE_MODEL || 'gemini-2.5-flash';
const HAS_KEY = !!(process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GOOGLE_API_KEY);

const layer = new GoogleSchemaCompatLayer({
  provider: 'google',
  modelId: MODEL_ID,
  supportsStructuredOutputs: false,
});

const REJECTED_BY_GEMINI_LIVE = new Set(['$schema', 'additionalProperties', 'propertyNames', 'oneOf', 'const']);

function findRejected(schema: unknown, path: string[] = []): string[] {
  if (schema === null || typeof schema !== 'object') return [];
  const found: string[] = [];
  for (const key of Object.keys(schema)) {
    if (REJECTED_BY_GEMINI_LIVE.has(key)) found.push([...path, key].join('.'));
  }
  if (Array.isArray((schema as any).anyOf)) {
    (schema as any).anyOf.forEach((branch: any, i: number) => {
      if (branch && typeof branch === 'object' && branch.type === 'null') {
        found.push([...path, `anyOf[${i}].type=null`].join('.'));
      }
    });
  }
  for (const [key, value] of Object.entries(schema)) {
    if (Array.isArray(value)) {
      value.forEach((v, i) => found.push(...findRejected(v, [...path, `${key}[${i}]`])));
    } else if (value && typeof value === 'object') {
      found.push(...findRejected(value, [...path, key]));
    }
  }
  return found;
}

type Case = {
  label: string;
  schema: z.ZodTypeAny;
  exercises: string[];
  /** Live-REST-only fields. Omit to skip this case from the live probe. */
  live?: {
    prompt: string;
    /** Returns null if tool input matches expectation, else a string with the failure reason. */
    check: (input: unknown) => string | null;
  };
};

const cases: Case[] = [
  {
    label: 'z.literal — standalone string `const`',
    schema: z.object({
      status: z.literal('active').describe('Must be the string "active"'),
      name: z.string().describe('A short user name'),
    }),
    exercises: ['const'],
    live: {
      prompt: 'Call myTool with status="active" and name="Alice".',
      check: (input: any) =>
        input?.status !== 'active'
          ? `expected status="active", got ${JSON.stringify(input?.status)}`
          : typeof input?.name !== 'string' || input.name.length === 0
            ? `expected non-empty name, got ${JSON.stringify(input?.name)}`
            : null,
    },
  },
  {
    label: 'z.union of literals — `anyOf` of `const` (no `oneOf`)',
    schema: z.object({ mode: z.union([z.literal('a'), z.literal('b')]) }),
    exercises: ['const'],
  },
  {
    label: 'z.discriminatedUnion — `oneOf` + `const` (the load-bearing bug)',
    schema: z.object({
      shape: z
        .discriminatedUnion('kind', [
          z.object({ kind: z.literal('circle'), r: z.number().describe('radius in cm') }),
          z.object({ kind: z.literal('square'), s: z.number().describe('side length in cm') }),
        ])
        .describe('A shape to draw'),
    }),
    exercises: ['oneOf', 'const'],
    live: {
      prompt: 'Call myTool with a circle of radius 5cm.',
      check: (input: any) => {
        if (!input?.shape || typeof input.shape !== 'object') return 'shape missing';
        const { kind } = input.shape;
        if (kind !== 'circle' && kind !== 'square') return `expected kind=circle|square, got ${JSON.stringify(kind)}`;
        if (kind === 'circle' && typeof input.shape.r !== 'number') return `expected numeric r, got ${JSON.stringify(input.shape.r)}`;
        if (kind === 'square' && typeof input.shape.s !== 'number') return `expected numeric s, got ${JSON.stringify(input.shape.s)}`;
        return null;
      },
    },
  },
  {
    label: 'z.union of objects — `anyOf` + `const` (control for the disc. union case)',
    schema: z.object({
      shape: z
        .union([
          z.object({ kind: z.literal('circle'), r: z.number().describe('radius in cm') }),
          z.object({ kind: z.literal('square'), s: z.number().describe('side length in cm') }),
        ])
        .describe('A shape to draw'),
    }),
    exercises: ['anyOf (control)', 'const'],
    live: {
      prompt: 'Call myTool with a circle of radius 5cm.',
      check: (input: any) => {
        if (!input?.shape || typeof input.shape !== 'object') return 'shape missing';
        const { kind } = input.shape;
        if (kind !== 'circle' && kind !== 'square') return `expected kind=circle|square, got ${JSON.stringify(kind)}`;
        if (kind === 'circle' && typeof input.shape.r !== 'number') return `expected numeric r, got ${JSON.stringify(input.shape.r)}`;
        if (kind === 'square' && typeof input.shape.s !== 'number') return `expected numeric s, got ${JSON.stringify(input.shape.s)}`;
        return null;
      },
    },
  },
  {
    label: 'z.nullable — `anyOf` with `{type:"null"}` branch on processToJSONSchema',
    schema: z.object({ count: z.number().nullable() }),
    exercises: ['type:null branch'],
  },
  {
    label: 'z.record — `propertyNames` + sub-schema `additionalProperties`',
    schema: z.object({ flags: z.record(z.string(), z.boolean()).describe('A map of feature flag names to booleans') }),
    exercises: ['propertyNames', 'additionalProperties (sub-schema)'],
    live: {
      prompt: 'Call myTool with flags={"darkMode": true, "betaFeature": false}.',
      check: (input: any) => {
        if (!input?.flags || typeof input.flags !== 'object') return 'flags missing';
        const entries = Object.entries(input.flags);
        if (entries.length === 0) return 'flags is empty';
        for (const [k, v] of entries) {
          if (typeof k !== 'string') return `non-string key: ${JSON.stringify(k)}`;
          if (typeof v !== 'boolean') return `non-boolean value for ${k}: ${JSON.stringify(v)}`;
        }
        return null;
      },
    },
  },
  {
    label: 'Plain z.object — root `additionalProperties: false` + `$schema`',
    schema: z.object({ name: z.string() }),
    exercises: ['$schema', 'additionalProperties: false (root)'],
  },
];

// ============================================================
// PART 1 — STATIC LAYER OUTPUT
// ============================================================
console.log('Layer: GoogleSchemaCompatLayer (modelId:', MODEL_ID + ')\n');
console.log('Gemini Live rejects these keys with `Unknown name "<key>"` (closes WS code 1007):');
console.log('  $schema, additionalProperties, propertyNames, oneOf, const, array-form `type`');
console.log("  (verdict table: https://github.com/mastra-ai/mastra/issues/17020)\n");
console.log("OpenAPI 3.0 Schema Object (@google/genai's `Schema` typedef) has NONE of these.\n");

for (const { label, schema, exercises } of cases) {
  console.log('='.repeat(72));
  console.log('[STATIC] ' + label);
  console.log('  expected to surface: ' + exercises.join(', '));
  console.log('='.repeat(72));

  const json = layer.processToJSONSchema(schema, 'input');
  const ai = layer.processToAISDKSchema(schema).jsonSchema;

  console.log('\n-- processToJSONSchema --');
  console.log(JSON.stringify(json, null, 2));
  const jsonRejected = findRejected(json);
  console.log('  Gemini-Live-rejected keys: ' + (jsonRejected.length === 0 ? 'NONE' : jsonRejected.join(', ')));

  console.log('\n-- processToAISDKSchema.jsonSchema --');
  console.log(JSON.stringify(ai, null, 2));
  const aiRejected = findRejected(ai);
  console.log('  Gemini-Live-rejected keys: ' + (aiRejected.length === 0 ? 'NONE' : aiRejected.join(', ')));
  console.log();
}

// ============================================================
// PART 2 — LIVE REST PROBE
// ============================================================
console.log('='.repeat(72));
console.log('PART 2 — LIVE REST PROBE');
console.log('='.repeat(72));

if (!HAS_KEY) {
  console.log('SKIPPED — set GOOGLE_GENERATIVE_AI_API_KEY (or GOOGLE_API_KEY) to enable.\n');
  console.log('When enabled, calls Gemini REST against PROBE_MODEL (default: gemini-2.5-flash)');
  console.log('for each schema that has a `live` config and reports PASS/FAIL based on whether');
  console.log('the model\'s tool args validate.\n');
  process.exit(0);
}

const model = google(MODEL_ID);
const liveCases = cases.filter((c): c is Case & { live: NonNullable<Case['live']> } => Boolean(c.live));
const results: Array<{ label: string; verdict: 'PASS' | 'FAIL' | 'ERROR'; detail: string }> = [];

for (const { label, schema, exercises, live } of liveCases) {
  console.log('\n' + '='.repeat(72));
  console.log('[LIVE] ' + label);
  console.log('  exercises: ' + exercises.join(', '));
  console.log('='.repeat(72));

  let captured: unknown = undefined;
  try {
    const aiSchema = layer.processToAISDKSchema(schema);
    const result = await generateText({
      model,
      tools: {
        myTool: {
          description: 'Test tool. Call with valid sample data.',
          inputSchema: aiSchema as any,
          execute: async (input: unknown) => {
            captured = input;
            return { ok: true };
          },
        },
      },
      toolChoice: 'auto',
      stopWhen: stepCountIs(2),
      prompt: live.prompt,
    });

    console.log('finishReason: ' + result.finishReason);
    const firstCall = result.steps?.[0]?.content?.find((c: any) => c?.type === 'tool-call');
    if (firstCall && (firstCall as any).invalid) {
      console.log('AI SDK marked tool call invalid:');
      console.log('  raw model output: ' + JSON.stringify((firstCall as any).input));
      console.log('  validator error : ' + ((firstCall as any).error?.cause?.cause?.message ?? '').replace(/\n/g, ' ').slice(0, 200));
    } else {
      console.log('tool input received: ' + JSON.stringify(captured));
    }

    const fail = live.check(captured);
    if (fail) {
      console.log('VERDICT: FAIL — ' + fail);
      results.push({ label, verdict: 'FAIL', detail: fail });
    } else {
      console.log('VERDICT: PASS');
      results.push({ label, verdict: 'PASS', detail: '' });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.name + ': ' + err.message : String(err);
    console.log('VERDICT: ERROR — ' + msg);
    results.push({ label, verdict: 'ERROR', detail: msg });
  }
}

console.log('\n' + '='.repeat(72));
console.log('LIVE REST verdict against ' + MODEL_ID);
console.log('='.repeat(72));
for (const { label, verdict, detail } of results) {
  console.log('  [' + verdict + '] ' + label + (detail ? ' — ' + detail : ''));
}

const allPass = results.every(r => r.verdict === 'PASS');
console.log('\nConclusion:');
if (allPass) {
  console.log('  REST tolerates every out-of-spec key the layer emits AND populates tool args correctly.');
  console.log('  The user-visible bug is Gemini Live only; layer fix is architectural cleanup.');
} else {
  console.log('  REST is affected — the layer fix is a correctness bug for non-Live consumers too.');
  console.log('  See raw failure capture above and the README for details.');
}

process.exit(allPass ? 0 : 1);
