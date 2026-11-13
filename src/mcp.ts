import pkg from '../package.json';

export type Content =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; mimeType: string; blob: string } };

export type Tool = {
  name: string;
  description: string;
  inputSchema: object;
  annotations?: { readOnlyHint?: boolean; openWorldHint?: boolean };
  run(args: Record<string, any>): Promise<Content[]>;
};

// Newest first. Older clients ignore the fields later versions added (tool annotations).
const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

type Message = { id?: string | number; method: string; params?: any };

// Minimal MCP over stdio: newline-delimited JSON-RPC, tools only.
export async function handle(tools: Tool[], { id, method, params = {} }: Message): Promise<object | undefined> {
  if (id === undefined) return; // notifications need no reply
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
