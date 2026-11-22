import type {
  Agent,
  Overview,
  Run,
  RunDependency,
  Scope,
} from "@/api/types.gen";

const ACTIVE_STATUSES = new Set([
  "starting",
  "running",
  "waiting_user",
  "cancelling",
  "unknown",
]);

const WAITABLE_STATUSES = new Set([
  "starting",
  "running",
  "waiting_user",
  "cancelling",
  "queued",
]);

const BLOCKED_STATUSES = new Set([
  "failed",
  "interrupted",
  "cancelled",
  "unknown",
  "paused",
]);

export type WaitableRun = {
  run: Run;
  title: string;
  agent?: Agent;
  chatTitle?: string;
  directoryLabel: string;
  sameScope: boolean;
};

export function normalizeScopePath(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[A-Za-z]:/.test(normalized) ? normalized.toLowerCase() : normalized;
}

export function sharesDirectory(aPaths: string[], bPaths: string[]) {
  if (!aPaths.length || !bPaths.length) return false;
  const left = aPaths.map(normalizeScopePath).filter(Boolean);
  const right = bPaths.map(normalizeScopePath).filter(Boolean);
  for (const a of left) {
    for (const b of right) {
      if (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) {
        return true;
      }
    }
  }
  return false;
}

function directoryBasename(path?: string) {
  if (!path) return "";
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").pop() || normalized;
}

export function isWaitableRunStatus(status: string) {
  return WAITABLE_STATUSES.has(status);
}

export function isDependencyBlocked(status: string) {
  return BLOCKED_STATUSES.has(status);
}

export function dependencyProgress(waitingOn?: RunDependency[]) {
  const deps = waitingOn ?? [];
  const total = deps.length;
  let completed = 0;
  let blocked = 0;
  for (const dep of deps) {
    if (dep.status === "completed") completed++;
    else if (isDependencyBlocked(dep.status)) blocked++;
  }
  return {
    total,
    completed,
    blocked,
    pending: total - completed - blocked,
  };
}

export function runDisplayTitle(
  run: Run,
  overview?: Pick<Overview, "conversations" | "chats" | "agents">,
) {
  const conversation = overview?.conversations.find(
    (item) => item.id === run.sessionId,
  );
  const chat = overview?.chats.find((item) => item.id === run.chatId);
  const agent = overview?.agents.find((item) => item.id === run.agentId);
  const firstLine = run.input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  const raw =
    (conversation?.kind === "topic" && conversation.title) ||
    firstLine ||
    conversation?.title ||
    run.quote?.text?.trim() ||
    run.attachments?.[0]?.name ||
    run.references?.[0]?.name ||
    chat?.title ||
    agent?.name ||
    run.id;
  return raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
}

export function listWaitableRuns(
  overview: Pick<Overview, "agents" | "chats" | "conversations" | "runs"> | undefined,
  currentScope: Scope,
  options?: { excludeSessionId?: string; excludeRunId?: string },
): WaitableRun[] {
  if (!overview) return [];
  const currentPaths = currentScope.roots.map((root) => root.path);
  const agents = new Map(overview.agents.map((agent) => [agent.id, agent]));
  const chats = new Map(overview.chats.map((chat) => [chat.id, chat]));
  const result: WaitableRun[] = [];
  for (const run of overview.runs) {
    if (run.quiet || run.superseded || run.steerRunId) continue;
    if (!WAITABLE_STATUSES.has(run.status)) continue;
    if (options?.excludeRunId && run.id === options.excludeRunId) continue;
    if (options?.excludeSessionId && run.sessionId === options.excludeSessionId)
      continue;
    const agent = agents.get(run.agentId);
    const runPaths =
      run.scopePaths?.length
        ? run.scopePaths
        : (agent?.profile.roots.map((root) => root.path) ?? []);
    const sameScope = sharesDirectory(currentPaths, runPaths);
    result.push({
      run,
      title: runDisplayTitle(run, overview),
      agent,
      chatTitle: chats.get(run.chatId)?.title,
      directoryLabel: directoryBasename(runPaths[0]),
      sameScope,
    });
  }
  result.sort((a, b) => {
    if (a.sameScope !== b.sameScope) return a.sameScope ? -1 : 1;
    const aActive = ACTIVE_STATUSES.has(a.run.status) ? 0 : 1;
    const bActive = ACTIVE_STATUSES.has(b.run.status) ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    return a.run.sequence - b.run.sequence;
  });
  return result;
}

export function defaultWaitRunIds(candidates: WaitableRun[]) {
  const sameScope = candidates.filter((item) => item.sameScope);
  const activeSameScope = sameScope.filter((item) =>
    ACTIVE_STATUSES.has(item.run.status),
  );
  const picked = activeSameScope.length > 0 ? activeSameScope : sameScope;
  return picked.map((item) => item.run.id);
}
