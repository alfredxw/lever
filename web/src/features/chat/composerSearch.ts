type SearchOption = {
  id: string;
  name: string;
  description: string;
  command?: string;
};

export type ComposerTrigger = {
  kind: "mention" | "command";
  prefix: string;
  query: string;
  start: number;
  end: number;
};

const MENTION_TRIGGER =
  /(?:^|[\s\ufffc\p{Script=Han}，。；（(])(@)((?:[^\s@\ufffc,?!;，。？！；：、）》】」』]+(?: [^\s@\ufffc,?!;，。？！；：、）》】」』]+)*)?)$/u;
const COMMAND_TRIGGER = /(?:^|[\s\ufffc])([/、])([^\s\ufffc]*)$/;
const INLINE_SLASH_TRIGGER =
  /(?:^|[\s\ufffc])[^\s/@\\\ufffc]*[\p{Script=Han}，。；：（(](\/)([^\s/@\\\ufffc]*)$/u;
const MAX_MENTION_QUERY = 100;

export function matchComposerTrigger(
  before: string,
  cursor: number,
): ComposerTrigger | null {
  const match =
    COMMAND_TRIGGER.exec(before) ||
    MENTION_TRIGGER.exec(before) ||
    INLINE_SLASH_TRIGGER.exec(before);
  if (!match) return null;
  const [, prefix, query] = match;
  if (prefix === "@" && query.length > MAX_MENTION_QUERY) return null;
  return {
    kind: prefix === "@" ? "mention" : "command",
    prefix,
    query,
    start: cursor - query.length - 1,
    end: cursor,
  };
}

// Keep the first keyboard choice on the named source when another group only
// matches its parent Chat, notebook, or Agent in the description.
export function rankMentionGroups<
  T extends { options: readonly SearchOption[] },
>(groups: T[], query: string) {
  const term = query.trim().toLowerCase();
  if (!term) return groups;
  const score = (group: T) =>
    scoreMatch(group.options[0]?.name.toLowerCase() ?? "", term, "name");
  return [...groups].sort((a, b) => score(a) - score(b));
}

// Names support abbreviations; descriptions only match contiguous text.
export function searchComposerOptions<T extends SearchOption>(
  options: readonly T[],
  query: string,
): T[] {
  const search = query
    .trim()
    .replace(/^[/、]+/, "")
    .toLowerCase();
  if (!search) return [...options];

  return options
    .map((option) => ({
      option,
      score: Math.min(
        scoreMatch(
          option.name.replace(/^\/+/, "").toLowerCase(),
          search,
          "name",
        ),
        scoreMatch(
          option.description.toLowerCase(),
          search,
          option.command ? "commandDescription" : "skillDescription",
        ),
      ),
      tieBreaker: `${option.command ? "0" : "1"}\0${option.name}\0${option.id}`,
    }))
    .filter(({ score }) => Number.isFinite(score))
    .sort(
      (a, b) => a.score - b.score || a.tieBreaker.localeCompare(b.tieBreaker),
    )
    .map(({ option }) => option);
}

function scoreMatch(
  value: string,
  query: string,
  field: "name" | "commandDescription" | "skillDescription",
): number {
  if (!value) return Infinity;
  const base = field === "name" ? 0 : field === "commandDescription" ? 20 : 30;
  const penalty = Math.min(64, Math.max(0, value.length - query.length));
  if (value === query) return base;
  if (value.startsWith(query)) return base + 2 + penalty;

  const markers = field === "name" ? ["-", "_", "/"] : [" ", "-", "_", "/"];
  let boundary = Infinity;
  for (const marker of markers) {
    const index = value.indexOf(`${marker}${query}`);
    if (index !== -1) boundary = Math.min(boundary, index + marker.length);
  }
  if (Number.isFinite(boundary)) return base + 4 + boundary * 2 + penalty;
  const index = value.indexOf(query);
  if (index !== -1) return base + 6 + index * 2 + penalty;
  if (field !== "name") return Infinity;

  let queryIndex = 0;
  let firstMatch = -1;
  let previousMatch = -1;
  let gaps = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== query[queryIndex]) continue;
    if (firstMatch === -1) firstMatch = i;
    if (previousMatch !== -1) gaps += i - previousMatch - 1;
    previousMatch = i;
    queryIndex++;
    if (queryIndex === query.length) {
      const span = i - firstMatch + 1 - query.length;
      return 100 + firstMatch * 2 + gaps * 3 + span + penalty;
    }
  }
  return Infinity;
}
