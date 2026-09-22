import { describe, expect, it } from 'vitest';
import { connectionSchema, parseDefinition } from '../src/contract';

const tool = { name: 'getStock', description: 'Read stock.', inputSchema: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'] },
  requests: [{ method: 'GET', path: '/v1.0/inventory/{sku}' }],
  code: 'async (input) => api.request({method: "GET", path: "/v1.0/inventory/" + encodeURIComponent(input.sku)})' };

describe('agent-authored definitions', () => {
  it('accepts JavaScript with declared reads and real input schemas', () => {
    expect(parseDefinition(JSON.stringify({ label: 'Inventory', tools: [tool] })).tools[0]?.code).toBe(tool.code);
  });
  it('rejects duplicate tools, malformed schemas and unknown credential fields', () => {
    for (const definition of [
      { label: 'Inventory', tools: [tool, tool] },
      { label: 'Inventory', tools: [{ ...tool, inputSchema: { type: 'string' } }] },
      { label: 'Inventory', tools: [tool], credential: 'synthetic-input-rejected' },
    ]) expect(() => parseDefinition(JSON.stringify(definition))).toThrow();
  });
  it('requires a canonical connection and explicit upstream read-only enforcement', () => {
    const connection = { origin: 'https://api.example.com', upstreamEnforcesReadOnly: true, authHeader: 'authorization', authPrefix: 'Bearer ' };
    expect(connectionSchema.safeParse(connection).success).toBe(true);
    expect(connectionSchema.safeParse({ ...connection, upstreamEnforcesReadOnly: false }).success).toBe(false);
    expect(connectionSchema.safeParse({ ...connection, origin: 'https://api.example.com/path' }).success).toBe(false);
    expect(connectionSchema.safeParse({ ...connection, authHeader: 'host' }).success).toBe(false);
  });
});
