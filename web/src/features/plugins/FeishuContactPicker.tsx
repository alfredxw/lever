import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  UserPlus,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "@/api/client";
import type { FeishuContact, FeishuContactSearchResult } from "@/api/types.gen";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { feishuPath } from "./channelQuery";
import { shortId } from "./feishuBotHelpers";

export function FeishuUserAvatar({
  name,
  avatarUrl,
  openId,
  size = "xs",
}: {
  name?: string;
  avatarUrl?: string;
  openId: string;
  size?: "xs" | "sm";
}) {
  const [imgFailed, setImgFailed] = useState(false);

  useEffect(() => {
    setImgFailed(false);
  }, [avatarUrl]);

  const initial = (name?.trim() || openId.replace(/^ou_/, "") || "?")
    .slice(0, 1)
    .toUpperCase();

  if (avatarUrl && !imgFailed) {
    return (
      <img
        src={avatarUrl}
        alt=""
        aria-hidden="true"
        className="feishu-user-avatar"
        data-size={size}
        onError={() => setImgFailed(true)}
      />
    );
  }

  return (
    <span
      className="feishu-user-avatar feishu-user-avatar-fallback"
      data-size={size}
      aria-hidden="true"
    >
      {initial}
    </span>
  );
}

function parseDirectOpenIds(raw: string): string[] {
  return raw
    .split(/[\s,，]+/u)
    .map((s) => s.trim())
    .filter((s) => /^ou_[A-Za-z0-9_-]{3,}$/.test(s));
}

export function FeishuContactPicker({
  botId,
  appId,
  brand,
  items,
  knownUsers,
  staticChips,
  triggerLabel,
  searchPlaceholder,
  disabled,
  align = "end",
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  onChange,
}: {
  botId: string;
  appId: string;
  brand: string;
  items: string[];
  knownUsers?: FeishuContact[];
  staticChips?: string[];
  triggerLabel: string;
  searchPlaceholder: string;
  disabled?: boolean;
  align?: "start" | "end";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onChange: (next: string[], picked?: FeishuContact) => void;
}) {
  const { t } = useTranslation();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = (next: boolean) => {
    controlledOnOpenChange?.(next);
    if (controlledOpen === undefined) {
      setUncontrolledOpen(next);
    }
  };

  const [query, setQuery] = useState("");
  const [refreshTick, setRefreshTick] = useState(0);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState("");
  const [result, setResult] = useState<FeishuContactSearchResult | null>(null);
  const [localCache, setLocalCache] = useState<Record<string, FeishuContact>>(
    {},
  );
  const inputRef = useRef<HTMLInputElement>(null);

  // Merge server-hydrated knownUsers with contacts picked in this session.
  const profileMap = useMemo(() => {
    const map = new Map<string, FeishuContact>();
    for (const u of knownUsers ?? []) {
      map.set(u.openId, u);
    }
    for (const [id, u] of Object.entries(localCache)) {
      const prev = map.get(id);
      map.set(id, prev ? { ...prev, ...u } : u);
    }
    return map;
  }, [knownUsers, localCache]);

  // Reset search state when switching bots or closing popover.
  useEffect(() => {
    setLocalCache({});
    setResult(null);
    setQuery("");
    setFetchError("");
  }, [botId]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setFetchError("");
      return;
    }
    const ac = new AbortController();
    const trimmed = query.trim();
    const delay = trimmed === "" && refreshTick === 0 ? 0 : 180;
    const isRefresh = refreshTick > 0;
    const timer = setTimeout(() => {
      setLoading(true);
      setFetchError("");
      const params = new URLSearchParams();
      if (trimmed) params.set("q", trimmed);
      if (isRefresh) params.set("refresh", "1");
      const qs = params.toString();
      const path = `${feishuPath}/bots/${encodeURIComponent(botId)}/contacts${qs ? `?${qs}` : ""}`;
      api<FeishuContactSearchResult>(path, undefined, "GET", ac.signal)
        .then((res) => {
          if (ac.signal.aborted) return;
          setResult(res);
          if (res.contacts?.length) {
            setLocalCache((prev) => {
              const next = { ...prev };
              for (const c of res.contacts) {
                if (c.openId && (c.name || c.avatarUrl || c.email)) {
                  next[c.openId] = { ...prev[c.openId], ...c };
                }
              }
              return next;
            });
          }
        })
        .catch((err: unknown) => {
          if (ac.signal.aborted) return;
          setFetchError(
            err instanceof Error ? err.message : t("channels.bot.contactLoadFailed"),
          );
        })
        .finally(() => {
          if (!ac.signal.aborted) setLoading(false);
        });
    }, delay);

    return () => {
      clearTimeout(timer);
      ac.abort();
    };
  }, [open, query, refreshTick, botId, t]);

  const itemSet = useMemo(() => new Set(items), [items]);
  const contacts = result?.contacts ?? [];
  const directIds = useMemo(() => parseDirectOpenIds(query), [query]);
  const isCrossAppWarning = result?.warning === "cross_app_open_id";
  const addableDirectIds = useMemo(() => {
    if (isCrossAppWarning || directIds.length === 0) return [];
    const listed = new Set(contacts.map((c) => c.openId));
    return directIds.filter((id) => !itemSet.has(id) && !listed.has(id));
  }, [isCrossAppWarning, directIds, contacts, itemSet]);

  const addContact = (contact: FeishuContact) => {
    if (!contact.openId || itemSet.has(contact.openId)) return;
    setLocalCache((prev) => ({
      ...prev,
      [contact.openId]: { ...prev[contact.openId], ...contact },
    }));
    onChange([...items, contact.openId], contact);
  };

  const addDirectOpenIds = (ids: string[]) => {
    const next = [...items];
    for (const id of ids) {
      if (!next.includes(id)) next.push(id);
    }
    if (next.length !== items.length) {
      onChange(next);
    }
    setQuery("");
  };

  const handleInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (isCrossAppWarning) return;
    const firstPickable = contacts.find((c) => !itemSet.has(c.openId));
    if (firstPickable && directIds.length <= 1) {
      addContact(firstPickable);
      setQuery("");
      return;
    }
    if (addableDirectIds.length > 0) {
      addDirectOpenIds(addableDirectIds);
    }
  };

  const domain = brand === "lark" ? "larksuite.com" : "feishu.cn";

  return (
    <div className="feishu-chip-list" data-align={align}>
      {staticChips?.map((label) => (
        <span key={label} className="feishu-chip">
          {label}
        </span>
      ))}
      {items.map((openId) => {
        const profile = profileMap.get(openId);
        const displayName = profile?.name || profile?.enName;
        const tooltip = [displayName, profile?.email, openId]
          .filter(Boolean)
          .join(" · ");
        return (
          <span
            key={openId}
            className="feishu-chip"
            title={tooltip || openId}
          >
            {displayName ? (
              <>
                <FeishuUserAvatar
                  name={displayName}
                  avatarUrl={profile?.avatarUrl}
                  openId={openId}
                  size="xs"
                />
                <span className="max-w-[140px] truncate">{displayName}</span>
              </>
            ) : (
              <span className="font-mono">{shortId(openId)}</span>
            )}
            <button
              type="button"
              className="feishu-chip-remove"
              disabled={disabled}
              aria-label={t("channels.bot.removeItem", {
                item: displayName || openId,
              })}
              onClick={() => onChange(items.filter((x) => x !== openId))}
            >
              <X className="size-3" />
            </button>
          </span>
        );
      })}

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={disabled}
            aria-label={triggerLabel}
          >
            <UserPlus data-icon="inline-start" />
            {triggerLabel}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align={align}
          className="feishu-contact-popover"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            inputRef.current?.focus();
          }}
        >
          <div className="flex items-center gap-1.5">
            <InputGroup className="min-w-0 flex-1">
              <InputGroupAddon>
                {loading ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Search />
                )}
              </InputGroupAddon>
              <InputGroupInput
                ref={inputRef}
                aria-label={searchPlaceholder}
                placeholder={searchPlaceholder}
                value={query}
                onChange={(e) => {
                  setRefreshTick(0);
                  setQuery(e.target.value);
                }}
                onKeyDown={handleInputKeyDown}
              />
            </InputGroup>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0"
              disabled={loading}
              aria-label={t("channels.bot.contactRefresh")}
              onClick={() => setRefreshTick((n) => n + 1)}
            >
              <RefreshCw
                className={loading ? "size-3.5 animate-spin" : "size-3.5"}
              />
            </Button>
          </div>

          {isCrossAppWarning && (
            <div className="feishu-contact-warning" role="alert">
              <AlertTriangle
                className="mt-0.5 size-3.5 shrink-0 text-[var(--status-attention)]"
                aria-hidden="true"
              />
              <span>{t("channels.bot.contactCrossAppWarning")}</span>
            </div>
          )}

          {fetchError && (
            <p className="px-1.5 py-1 text-xs text-destructive">{fetchError}</p>
          )}

          <div
            className="feishu-contact-list"
            role="listbox"
            aria-label={triggerLabel}
          >
            {contacts.map((contact) => {
              const added = itemSet.has(contact.openId);
              const primary =
                contact.name || contact.enName || shortId(contact.openId);
              const secondary =
                contact.email ||
                contact.department ||
                shortId(contact.openId);
              const sourceKey =
                contact.source === "directory"
                  ? "channels.bot.contactSource.directory"
                  : contact.source === "chat"
                    ? "channels.bot.contactSource.chat"
                    : contact.source === "recent"
                      ? "channels.bot.contactSource.recent"
                      : null;
              return (
                <button
                  key={contact.openId}
                  type="button"
                  role="option"
                  aria-selected={added}
                  disabled={added}
                  className="feishu-contact-option"
                  onClick={() => addContact(contact)}
                >
                  <FeishuUserAvatar
                    name={primary}
                    avatarUrl={contact.avatarUrl}
                    openId={contact.openId}
                    size="sm"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-xs font-medium text-foreground">
                        {primary}
                      </span>
                      {sourceKey && (
                        <span className="feishu-contact-source">
                          {t(sourceKey)}
                        </span>
                      )}
                    </span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {secondary}
                    </span>
                  </span>
                  {added ? (
                    <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                      <Check className="size-3.5" />
                      {t("channels.bot.contactAdded")}
                    </span>
                  ) : (
                    <Plus className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                </button>
              );
            })}

            {addableDirectIds.length > 0 && (
              <button
                type="button"
                className="feishu-contact-option"
                onClick={() => addDirectOpenIds(addableDirectIds)}
              >
                <span
                  className="feishu-user-avatar feishu-user-avatar-fallback"
                  data-size="sm"
                  aria-hidden="true"
                >
                  <Plus className="size-3.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-foreground">
                    {addableDirectIds.length === 1
                      ? t("channels.bot.contactAddDirectOne", {
                          id: shortId(addableDirectIds[0]),
                        })
                      : t("channels.bot.contactAddDirectMany", {
                          count: addableDirectIds.length,
                        })}
                  </span>
                  <span className="block truncate font-mono text-[11px] text-muted-foreground">
                    {addableDirectIds.join(", ")}
                  </span>
                </span>
              </button>
            )}

            {!loading &&
              contacts.length === 0 &&
              addableDirectIds.length === 0 &&
              !isCrossAppWarning && (
                <div className="px-2 py-4 text-center text-xs text-muted-foreground">
                  {query.trim()
                    ? t("channels.bot.contactEmptySearch", {
                        query: query.trim(),
                      })
                    : t("channels.bot.contactEmptyHint")}
                </div>
              )}
          </div>

          {result?.missingScopes && result.missingScopes.length > 0 && (
            <div className="feishu-contact-scope-hint">
              <span className="min-w-0 flex-1 leading-relaxed">
                {t("channels.bot.contactMissingScopes", {
                  scopes: result.missingScopes.join(", "),
                })}
              </span>
              <a
                href={`https://open.${domain}/app/${encodeURIComponent(appId)}/auth`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex shrink-0 items-center gap-0.5 font-medium text-foreground hover:underline"
              >
                {t("channels.bot.contactOpenConsole")}
                <ArrowUpRight className="size-3" />
              </a>
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
