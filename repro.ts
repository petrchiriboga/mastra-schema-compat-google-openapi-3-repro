/**
 * Two parts:
 *   1. Always — show the JSON Schema GoogleSchemaCompatLayer emits.
 *   2. If GOOGLE_GENERATIVE_AI_API_KEY is set — call Gemini REST and show
 *      whether tool args make it to execute().
 */
import { google } from '@ai-sdk/google';
import { GoogleSchemaCompatLayer } from '@mastra/schema-compat';
import { generateText, stepCountIs } from 'ai';
import { z } from 'zod';

const MODEL_ID = process.env.PROBE_MODEL || 'gemini-2.5-flash';
const layer = new GoogleSchemaCompatLayer({ provider: 'google', modelId: MODEL_ID, supportsStructuredOutputs: false });

const schemas = {
  // emits `oneOf` + `const` — the bug
  discriminatedUnion: z.object({
    shape: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('circle'), r: z.number().describe('radius in cm') }),
      z.object({ kind: z.literal('square'), s: z.number().describe('side length in cm') }),
    ]),
  }),
  // same union semantics expressed via z.union → emits `anyOf` + `const` (the control)
  union: z.object({
    shape: z.union([
      z.object({ kind: z.literal('circle'), r: z.number().describe('radius in cm') }),
      z.object({ kind: z.literal('square'), s: z.number().describe('side length in cm') }),
    ]),
  }),
};

// PART 1 — layer output
for (const [name, schema] of Object.entries(schemas)) {
  console.log(`\n--- layer output for ${name} ---`);
  console.log(JSON.stringify(layer.processToAISDKSchema(schema).jsonSchema, null, 2));
}

// PART 2 — live REST
if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY && !process.env.GOOGLE_API_KEY) {
  console.log('\n(set GOOGLE_GENERATIVE_AI_API_KEY to also run the live REST probe)');
  process.exit(0);
}

const model = google(MODEL_ID);
for (const [name, schema] of Object.entries(schemas)) {
  console.log(`\n--- live REST: ${name} ---`);
  let toolInput: unknown = undefined;
  const result = await generateText({
    model,
    tools: {
      myTool: {
        description: 'Call with valid sample data.',
        inputSchema: layer.processToAISDKSchema(schema) as any,
        execute: async (input: unknown) => { toolInput = input; return { ok: true }; },
      },
    },
    toolChoice: 'auto',
    stopWhen: stepCountIs(2),
    prompt: 'Call myTool with a circle of radius 5cm.',
  });
  const call = result.steps?.[0]?.content?.find((c: any) => c?.type === 'tool-call') as any;
  if (call?.invalid) {
    console.log(`AI SDK marked invalid:`);
    console.log(`  raw model output: ${JSON.stringify(call.input)}`);
    console.log(`  validator error : ${(call.error?.cause?.cause?.message ?? '').replace(/\n/g, ' ').slice(0, 220)}`);
  } else {
    console.log(`execute() received: ${JSON.stringify(toolInput)}`);
  }
}
