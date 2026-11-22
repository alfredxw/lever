import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';

export default async function register(pi) {
  const { LEVER_MCP_URL, LEVER_PI_BRIDGE, LEVER_PI_READY } = process.env;
  const credential = Symbol.for('lever.pi.mcpCredential');
  const LEVER_MCP_TOKEN = process.env.LEVER_MCP_TOKEN ?? globalThis[credential];
  if (!LEVER_MCP_TOKEN || !LEVER_PI_BRIDGE) return;
  const env = { LEVER_MCP_URL, LEVER_MCP_TOKEN };
  globalThis[credential] = LEVER_MCP_TOKEN;
  delete process.env.LEVER_MCP_TOKEN;
  if (pi.registerMcpServer) {
    pi.registerMcpServer('lever', { type: 'stdio', command: LEVER_PI_BRIDGE, args: ['--mcp-stdio'], env, exposure: 'direct' });
  } else {
    const request = (params, signal) => new Promise((resolve, reject) => {
      const child = execFile(LEVER_PI_BRIDGE, ['--pi-mcp-tool'], {
        env: { ...process.env, ...env }, signal, maxBuffer: 16 * 1024 * 1024,
      }, (error, stdout) => {
        if (error) return reject(error);
        try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
      });
      child.stdin.on('error', reject);
      child.stdin.end(JSON.stringify(params));
    });
    const tools = await request({});
    for (const tool of tools) {
      pi.registerTool({
        name: `mcp__lever__${tool.name}`, label: tool.name, description: tool.description,
        parameters: tool.inputSchema,
        async execute(_id, args, signal) {
          const result = await request({ name: tool.name, arguments: args }, signal);
          if (result.isError) throw new Error(result.content.map(part => part.text ?? '').join('\n'));
          return { content: result.content, details: result.structuredContent };
        },
      });
    }
    const required = (process.env.LEVER_PI_REQUIRED || '').split(',').filter(Boolean);
    pi.on('session_start', () => {
      const active = pi.getActiveTools();
      if (required.every(name => active.includes(`mcp__lever__${name}`))) {
        writeFileSync(LEVER_PI_READY, 'ready', { mode: 0o600 });
      }
    });
    return;
  }
  writeFileSync(LEVER_PI_READY, 'ready', { mode: 0o600 });
}
