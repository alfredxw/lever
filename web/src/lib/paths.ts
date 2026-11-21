export function directoryName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  if (/^[a-z]:$/i.test(trimmed)) return path;
  return trimmed.split(/[\\/]/).pop() || path;
}

export function displayPath(path: string, homeDir: string): string {
  const home = homeDir.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!home) return path;
  const normalized = path.replace(/\\/g, "/");
  const windows = /^[a-z]:\//i.test(home) || home.startsWith("//");
  const candidate = windows ? normalized.toLowerCase() : normalized;
  const prefix = windows ? home.toLowerCase() : home;
  if (candidate === prefix) return "~";
  return candidate.startsWith(`${prefix}/`)
    ? `~${normalized.slice(home.length)}`
    : path;
}
