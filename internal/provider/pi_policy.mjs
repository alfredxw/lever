import { writeFileSync } from 'node:fs';

const readOnly = new Set(['read', 'find', 'grep', 'ls', 'tool_search']);
const edits = new Set(['write', 'edit']);

function isBuiltin(pi, name) {
  const [tool, duplicate] = pi.getAllTools?.().filter(tool => tool.name === name) ?? [];
  const path = `builtin:${name === 'tool_search' ? 'tool-search' : name}`;
  return !duplicate && tool?.sourceInfo?.source === 'builtin' &&
    (tool.sourceInfo.path === path || tool.sourceInfo.path === `<${path}>`);
}

export default function register(pi) {
  const { LEVER_PI_POLICY: mode, LEVER_PI_POLICY_READY: ready, LEVER_PI_FAST_TIERS } = process.env;
  if (mode !== 'full_access') {
    pi.on('tool_call', async ({ toolName, input }, ctx) => {
      if ((readOnly.has(toolName) || (mode === 'accept_edits' && edits.has(toolName))) && isBuiltin(pi, toolName)) return;
      try {
        if (!ctx.signal?.aborted && await ctx.ui.confirm(`Allow ${toolName}?`, JSON.stringify(input, null, 2).slice(0, 4096), { signal: ctx.signal })) return;
      } catch {}
      return { block: true, reason: `${toolName} was not approved in Lever.` };
    });
  }
  if (LEVER_PI_FAST_TIERS) {
    const tiers = LEVER_PI_FAST_TIERS.split(',');
    pi.on('before_provider_request', ({ payload }, ctx) => {
      const tier = tiers.find(id => ctx.model?.serviceTiers?.some(option => option?.id === id));
      if (tier) return { ...payload, service_tier: tier };
    });
  }
  pi.on('session_start', () => writeFileSync(ready, 'ready', { mode: 0o600 }));
}
