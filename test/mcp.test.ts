import { expect, test } from 'bun:test';
import { handle, type Tool } from '../src/mcp';

const tools: Tool[] = [
  { name: 'ok', description: '', inputSchema: {}, run: async () => [{ type: 'text', text: 'hi' }] },
  { name: 'boom', description: '', inputSchema: {}, run: async () => { throw new Error('nope'); } },
];

test('reports tool failures as tool errors and unknown tools as protocol errors', async () => {
  expect(await handle(tools, { id: 1, method: 'tools/call', params: { name: 'boom' } })).toMatchObject({
    result: { isError: true, content: [{ text: 'nope' }] },
  });
  expect(await handle(tools, { id: 2, method: 'tools/call', params: { name: 'canvas_gte' } })).toMatchObject({ error: { code: -32602 } });
});

test('agrees to a protocol version it knows and offers its newest otherwise', async () => {
  const version = async (v: string) => ((await handle(tools, { id: 1, method: 'initialize', params: { protocolVersion: v } })) as any).result.protocolVersion;
  expect(await version('2025-03-26')).toBe('2025-03-26');
  expect(await version('2099-01-01')).toBe('2025-11-25');
});
