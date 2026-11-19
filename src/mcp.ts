import pkg from '../package.json';

export type Content =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; mimeType: string; blob: string } };

/** Longest text block sent to the model; anything past this is cut with a note saying so. */
const MAX_CHARS = 150_000;

export function text(s: string): Content {
  if (s.length <= MAX_CHARS) return { type: 'text', text: s };
  return { type: 'text', text: `${s.slice(0, MAX_CHARS)}\n[truncated at ${MAX_CHARS} characters]` };
}

/** An MCP tool: its definition as clients see it, plus `run`, which is kept server-side. */
export type Tool = {
  name: string;
  description: string;
  inputSchema: object;
  annotations?: { readOnlyHint?: boolean; openWorldHint?: boolean };
  run(args: Record<string, any>): Promise<Content[]>;
};

/** MCP protocol versions this server speaks, newest first. Older clients ignore later fields (tool annotations). */
const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

type Message = { id?: string | number; method: string; params?: any };

/** Answers one JSON-RPC message. Tool errors come back as an `isError` result, not a JSON-RPC error, so the model sees them. */
export async function handle(tools: Tool[], { id, method, params = {} }: Message): Promise<object | undefined> {
  if (id === undefined) return; // a notification: JSON-RPC sends no reply
  const result = (result: object) => ({ jsonrpc: '2.0', id, result });
  switch (method) {
    case 'initialize':
      return result({
        protocolVersion: VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'ubc-canvas', version: pkg.version },
      });
    case 'ping':
      return result({});
    case 'tools/list':
      return result({ tools: tools.map(({ run, ...definition }) => definition) });
    case 'tools/call': {
      const tool = tools.find((t) => t.name === params.name);
      if (!tool) return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${params.name}` } };
      try {
        return result({ content: await tool.run(params.arguments ?? {}) });
      } catch (e) {
        return result({ content: [{ type: 'text', text: (e as Error).message }], isError: true });
      }
    }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } };
  }
}

/** Minimal MCP over stdio: reads newline-delimited JSON-RPC and answers each message as it finishes. */
export async function serve(tools: Tool[]): Promise<void> {
  for await (const line of console) {
    let msg: Message;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(tools, msg).then((reply) => reply && process.stdout.write(JSON.stringify(reply) + '\n'));
  }
}
