/**
 * REST probe: does Gemini REST (`generateContent`) accept the out-of-spec
 * keys that `GoogleSchemaCompatLayer` emits today, and does the model still
 * populate tool arguments correctly?
 *
 * Companion to `repro.ts`. `repro.ts` proves the layer emits out-of-spec
 * keys; this script tests whether REST tolerates them in practice or
 * silently degrades tool-arg quality.
 *
 * Requires: `GOOGLE_GENERATIVE_AI_API_KEY` or `GOOGLE_API_KEY` in env.
 * Cost: ~3 short tool-call generations against `gemini-2.5-flash`.
 */
import { google } from '@ai-sdk/google';
import { GoogleSchemaCompatLayer } from '@mastra/schema-compat';
import { generateText, stepCountIs } from 'ai';
import { z } from 'zod';

const MODEL_ID = process.env.PROBE_MODEL || 'gemini-2.5-flash';

if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY && !process.env.GOOGLE_API_KEY) {
  console.error('Set GOOGLE_GENERATIVE_AI_API_KEY (or GOOGLE_API_KEY) before running.');
  process.exit(1);
}

const layer = new GoogleSchemaCompatLayer({
  provider: 'google',
  modelId: MODEL_ID,
  supportsStructuredOutputs: false,
});

const model = google(MODEL_ID);

type ProbeCase = {
  label: string;
  schema: z.ZodTypeAny;
  prompt: string;
  /** Predicate over the captured tool input. Returns null if OK, or a string with the failure reason. */
  check: (input: unknown) => string | null;
  /** Which problem keys this case exercises in the layer output. */
  exercises: string[];
};

const cases: ProbeCase[] = [
  {
    label: 'z.literal — exercises string `const`',
    schema: z.object({
      status: z.literal('active').describe('Must be the string "active"'),
      name: z.string().describe('A short user name'),
    }),
    prompt: 'Call myTool with status="active" and name="Alice".',
    exercises: ['const'],
    check: (input: any) => {
      if (!input || typeof input !== 'object') return 'tool input missing or not an object';
      if (input.status !== 'active') return `expected status="active", got ${JSON.stringify(input.status)}`;
      if (typeof input.name !== 'string' || input.name.length === 0) return `expected non-empty name, got ${JSON.stringify(input.name)}`;
      return null;
    },
  },
  {
    label: 'z.discriminatedUnion — exercises `oneOf` + `const`',
    schema: z.object({
      shape: z
        .discriminatedUnion('kind', [
          z.object({ kind: z.literal('circle'), r: z.number().describe('radius in cm') }),
          z.object({ kind: z.literal('square'), s: z.number().describe('side length in cm') }),
        ])
        .describe('A shape to draw'),
    }),
    prompt: 'Call myTool with a circle of radius 5cm.',
    exercises: ['oneOf', 'const'],
    check: (input: any) => {
      if (!input?.shape || typeof input.shape !== 'object') return 'shape missing';
      const { kind } = input.shape;
      if (kind !== 'circle' && kind !== 'square') return `expected kind=circle|square, got ${JSON.stringify(kind)}`;
      if (kind === 'circle' && typeof input.shape.r !== 'number') return `expected numeric r, got ${JSON.stringify(input.shape.r)}`;
      if (kind === 'square' && typeof input.shape.s !== 'number') return `expected numeric s, got ${JSON.stringify(input.shape.s)}`;
      return null;
    },
  },
  {
    label: 'z.union of objects — control for the disc. union case (produces `anyOf`, not `oneOf`)',
    schema: z.object({
      shape: z
        .union([
          z.object({ kind: z.literal('circle'), r: z.number().describe('radius in cm') }),
          z.object({ kind: z.literal('square'), s: z.number().describe('side length in cm') }),
        ])
        .describe('A shape to draw'),
    }),
    prompt: 'Call myTool with a circle of radius 5cm.',
    exercises: ['anyOf (control)', 'const'],
    check: (input: any) => {
      if (!input?.shape || typeof input.shape !== 'object') return 'shape missing';
      const { kind } = input.shape;
      if (kind !== 'circle' && kind !== 'square') return `expected kind=circle|square, got ${JSON.stringify(kind)}`;
      if (kind === 'circle' && typeof input.shape.r !== 'number') return `expected numeric r, got ${JSON.stringify(input.shape.r)}`;
      if (kind === 'square' && typeof input.shape.s !== 'number') return `expected numeric s, got ${JSON.stringify(input.shape.s)}`;
      return null;
    },
  },
  {
    label: 'z.record — exercises `propertyNames` + sub-schema `additionalProperties`',
    schema: z.object({
      flags: z.record(z.string(), z.boolean()).describe('A map of feature flag names to booleans'),
    }),
    prompt: 'Call myTool with flags={"darkMode": true, "betaFeature": false}.',
    exercises: ['propertyNames', 'additionalProperties (sub-schema)'],
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
];

const results: Array<{ label: string; verdict: 'PASS' | 'FAIL' | 'ERROR'; detail: string; toolInput: unknown }> = [];

for (const { label, schema, prompt, check, exercises } of cases) {
  console.log('\n' + '='.repeat(72));
  console.log(label);
  console.log(`  exercises: ${exercises.join(', ')}`);
  console.log('='.repeat(72));

  const aiSchema = layer.processToAISDKSchema(schema);
  console.log('\nlayer-emitted JSON Schema sent to REST:');
  console.log(JSON.stringify(aiSchema.jsonSchema, null, 2));

  let captured: unknown = undefined;
  try {
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
      prompt,
    });

    console.log(`\nfinishReason: ${result.finishReason}`);
    console.log('steps[0].content (raw model output):');
    console.log(JSON.stringify(result.steps?.[0]?.content, null, 2));
    console.log('steps[0].toolCalls:');
    console.log(JSON.stringify(result.steps?.[0]?.toolCalls, null, 2));
    console.log('tool input received in execute():');
    console.log(JSON.stringify(captured, null, 2));

    const fail = check(captured);
    if (fail) {
      console.log(`\nVERDICT: FAIL — ${fail}`);
      results.push({ label, verdict: 'FAIL', detail: fail, toolInput: captured });
    } else {
      console.log('\nVERDICT: PASS');
      results.push({ label, verdict: 'PASS', detail: '', toolInput: captured });
    }
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.log(`\nVERDICT: ERROR — ${msg}`);
    results.push({ label, verdict: 'ERROR', detail: msg, toolInput: captured });
  }
}

console.log('\n' + '='.repeat(72));
console.log('REST probe summary against', MODEL_ID);
console.log('='.repeat(72));
for (const { label, verdict, detail } of results) {
  console.log(`  [${verdict}] ${label}${detail ? ' — ' + detail : ''}`);
}

const allPass = results.every(r => r.verdict === 'PASS');
console.log('\nREST verdict:');
if (allPass) {
  console.log('  REST tolerates every out-of-spec key the layer emits, AND populates tool args correctly.');
  console.log('  The user-visible bug is Gemini Live only; layer fix is architectural cleanup.');
} else {
  console.log('  REST is affected. The layer fix is a correctness bug for non-Live consumers too.');
}

process.exit(allPass ? 0 : 1);
