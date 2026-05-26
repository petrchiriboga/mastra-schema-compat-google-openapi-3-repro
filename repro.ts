import { GoogleSchemaCompatLayer } from '@mastra/schema-compat';
import { z } from 'zod';

const layer = new GoogleSchemaCompatLayer({
  provider: 'google',
  modelId: 'gemini-2.5-pro',
  supportsStructuredOutputs: false,
});

const cases: Array<{ label: string; schema: z.ZodTypeAny; hits: string[] }> = [
  {
    label: 'z.literal — emits string `const`',
    schema: z.object({ status: z.literal('active') }),
    hits: ['const'],
  },
  {
    label: 'z.union of literals — emits `anyOf` (OK) with `const` branches (NOT OK)',
    schema: z.object({ mode: z.union([z.literal('a'), z.literal('b')]) }),
    hits: ['const'],
  },
  {
    label: 'z.discriminatedUnion — emits `oneOf` (NOT OK)',
    schema: z.object({
      shape: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('circle'), r: z.number() }),
        z.object({ kind: z.literal('square'), s: z.number() }),
      ]),
    }),
    hits: ['oneOf', 'const'],
  },
  {
    label: 'z.nullable — emits `anyOf` with `{type:"null"}` branch on processToJSONSchema',
    schema: z.object({ count: z.number().nullable() }),
    hits: ['type:null branch'],
  },
  {
    label: 'z.record — emits `propertyNames` + sub-schema `additionalProperties`',
    schema: z.object({ flags: z.record(z.string(), z.boolean()) }),
    hits: ['propertyNames', 'additionalProperties (sub-schema)'],
  },
  {
    label: 'Plain z.object — emits root `additionalProperties: false` + `$schema`',
    schema: z.object({ name: z.string() }),
    hits: ['$schema', 'additionalProperties: false (root)'],
  },
];

const REJECTED_BY_GEMINI_LIVE = new Set([
  '$schema',
  'additionalProperties',
  'propertyNames',
  'oneOf',
  'const',
]);

function findRejected(schema: unknown, path: string[] = []): string[] {
  if (schema === null || typeof schema !== 'object') return [];
  const found: string[] = [];
  for (const key of Object.keys(schema)) {
    if (REJECTED_BY_GEMINI_LIVE.has(key)) found.push([...path, key].join('.'));
  }
  // detect anyOf with null branch (`type: "null"`)
  if (Array.isArray((schema as any).anyOf)) {
    for (let i = 0; i < (schema as any).anyOf.length; i++) {
      const branch = (schema as any).anyOf[i];
      if (branch && typeof branch === 'object' && branch.type === 'null') {
        found.push([...path, `anyOf[${i}].type=null`].join('.'));
      }
    }
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

console.log('Layer:', 'GoogleSchemaCompatLayer (modelId: gemini-2.5-pro)\n');
console.log('Wire-probe reference (#17020): Gemini Live rejects these keys with');
console.log('  `Unknown name "<key>"` and closes the WebSocket with code 1007:');
console.log('  $schema, additionalProperties, propertyNames, oneOf, const,');
console.log('  array-form `type` (e.g. `["string","null"]`).\n');
console.log('OpenAPI 3.0 Schema Object (@google/genai\'s `Schema` typedef) has NONE of these.\n');

for (const { label, schema, hits } of cases) {
  console.log('='.repeat(72));
  console.log(label);
  console.log(`  expected to surface: ${hits.join(', ')}`);
  console.log('='.repeat(72));

  const json = layer.processToJSONSchema(schema, 'input');
  const ai = layer.processToAISDKSchema(schema).jsonSchema;

  const jsonRejected = findRejected(json);
  const aiRejected = findRejected(ai);

  console.log('\n-- processToJSONSchema --');
  console.log(JSON.stringify(json, null, 2));
  console.log(`\n  Gemini-Live-rejected keys present: ${jsonRejected.length === 0 ? 'NONE' : jsonRejected.join(', ')}`);

  console.log('\n-- processToAISDKSchema.jsonSchema --');
  console.log(JSON.stringify(ai, null, 2));
  console.log(`\n  Gemini-Live-rejected keys present: ${aiRejected.length === 0 ? 'NONE' : aiRejected.join(', ')}`);
  console.log();
}

console.log('='.repeat(72));
console.log('Summary');
console.log('='.repeat(72));
console.log('Every case above emits at least one key Gemini Live\'s WebSocket validator');
console.log('rejects. REST `generateContent` silently tolerates them, so the bug is');
console.log('latent until a consumer hits the stricter Live validator (or any future');
console.log('REST tightening). The fix belongs in `GoogleSchemaCompatLayer`, not in');
console.log('downstream sanitizers — every Google consumer in the monorepo benefits.');
