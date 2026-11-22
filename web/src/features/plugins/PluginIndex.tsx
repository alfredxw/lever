import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Rss, Search, X } from "lucide-react";
import type { Plugin, UpdateSettings } from "@/api/types.gen";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { OverviewNavigation } from "@/components/workbench/OverviewNavigation";
import { PluginIcon, pluginName, type PluginSignal } from "./PluginCard";
import type { PluginGroup } from "./pluginGroups";

export function PluginIndex({
  groups,
  selected,
  subscriptionsActive,
  updateCount,
  updateSettings,
  signalFor,
  total,
  subscriptionCount,
  search,
  onSearch,
  onSelect,
  onOverview,
  onSubscriptions,
  open,
  onOpenChange,
  compact,
  loading,
}: {
  groups: PluginGroup[];
  selected?: string;
  subscriptionsActive?: boolean;
  updateCount: number;
  updateSettings: UpdateSettings;
  signalFor: (plugin: Plugin) => PluginSignal;
  total: number;
  subscriptionCount: number;
  search: string;
  onSearch: (value: string) => void;
  onSelect: (id: string, trigger: HTMLElement) => void;
  onOverview: () => void;
  onSubscriptions: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  compact: boolean;
  loading: boolean;
}) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const names = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(open);

  useLayoutEffect(() => {
    if (open && !wasOpen.current) input.current?.focus({ preventScroll: true });
    wasOpen.current = open;
  }, [open]);

  useEffect(() => {
    const find = (event: globalThis.KeyboardEvent) => {
      if (
        event.key !== "/" ||
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.altKey ||
        event.metaKey ||
        event.ctrlKey ||
        (event.target instanceof HTMLElement &&
          (event.target.isContentEditable ||
            event.target.closest(
              'input, textarea, select, [role="textbox"], [role="menu"], [role="listbox"], [role="dialog"]',
            ))) ||
        document.querySelector(
          ':is([role="dialog"], [role="alertdialog"])[data-state="open"]',
        )
      )
        return;
      event.preventDefault();
      if (!open) onOpenChange(true);
      else {
        input.current?.focus({ preventScroll: true });
        input.current?.select();
      }
    };
    window.addEventListener("keydown", find);
    return () => window.removeEventListener("keydown", find);
  }, [open, onOpenChange]);

  function handleKeys(event: KeyboardEvent<HTMLElement>) {
    if (
      event.nativeEvent.isComposing ||
      event.keyCode === 229 ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    )
      return;
    const target = event.target;
    if (event.key === "Escape") {
      if (search) {
        event.preventDefault();
        onSearch("");
        input.current?.focus();
      } else if (compact) {
        event.preventDefault();
        onOpenChange(false);
      }
      return;
    }
    if (target === input.current && event.key === "Enter") {
      event.preventDefault();
      const first = groups[0]?.entries[0];
      if (first && input.current) onSelect(first.id, input.current);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = Array.from(names.current?.querySelectorAll("button") ?? []);
    if (!items.length) return;
    event.preventDefault();
    const down = event.key === "ArrowDown";
    const index =
      target instanceof HTMLButtonElement
        ? items.indexOf(target)
        : down
          ? -1
          : items.length;
    items[
      Math.max(0, Math.min(items.length - 1, index + (down ? 1 : -1)))
    ].focus();
  }

  return (
    <OverviewNavigation
      label={t("nav.plugins")}
      overviewLabel={t("plugins.allPlugins")}
      count={total}
      current={!selected && !subscriptionsActive}
      onOverview={onOverview}
      topItems={
        <Button
          variant="ghost"
          className="sidebar-nav-item"
          aria-current={subscriptionsActive ? "page" : undefined}
          onClick={onSubscriptions}
        >
          <Rss data-icon="inline-start" className="text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-start">
            {t("plugins.subscriptions")}
          </span>
          {updateCount > 0 ? (
            <span
              className="plugins-sidebar-badge tabular-nums"
              aria-hidden="true"
            >
              {updateCount}
            </span>
          ) : (
            <span
              className="text-[11px] text-muted-foreground tabular-nums"
              aria-hidden="true"
            >
              {subscriptionCount}
            </span>
          )}
        </Button>
      }
      search={
        <InputGroup className="sidebar-search-control mb-2 shrink-0">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            ref={input}
            type="search"
            autoComplete="off"
            spellCheck={false}
            className="[&::-webkit-search-cancel-button]:hidden"
            aria-label={t("plugins.search")}
            placeholder={t("plugins.search")}
            aria-keyshortcuts="/"
            aria-controls="plugin-index-groups"
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            onKeyDown={handleKeys}
          />
          <InputGroupAddon align="inline-end">
            {search ? (
              <InputGroupButton
                size="icon-xs"
                aria-label={t("plugins.clearSearch")}
                onClick={() => {
                  onSearch("");
                  input.current?.focus();
                }}
              >
                <X />
              </InputGroupButton>
            ) : (
              <kbd aria-hidden="true" className="rounded border px-1 text-xs">
                /
              </kbd>
            )}
          </InputGroupAddon>
        </InputGroup>
      }
      footer={
        <div className="flex items-center justify-between gap-2 px-1 text-[11px] text-muted-foreground">
          <span className="flex min-w-0 items-center gap-1.5 truncate">
            <span
              className="plugins-status-dot"
              data-tone={
                updateSettings.mode === "auto"
                  ? "positive"
                  : updateSettings.mode === "notify"
                    ? "running"
                    : "muted"
              }
              aria-hidden="true"
            />
            <span className="truncate tabular-nums">
              {t(`updates.policy.${updateSettings.mode}`)}
              {updateSettings.mode !== "manual"
                ? ` · ${updateSettings.interval}`
                : ""}
            </span>
          </span>
          <Button
            variant="ghost"
            size="xs"
            className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
            onClick={onSubscriptions}
          >
            {t("updates.policy")}
          </Button>
        </div>
      }
    >
      <div
        id="plugin-index-groups"
        className="flex flex-col gap-3"
        ref={names}
        onKeyDown={handleKeys}
      >
        {groups.map(({ id, label, entries }) => (
          <section key={id} aria-labelledby={`plugin-index-${id}`}>
            <h2
              id={`plugin-index-${id}`}
              className="flex h-7 items-center justify-between px-2 text-xs font-medium text-muted-foreground"
            >
              {t(label)}
              <span aria-hidden="true" className="text-[11px] tabular-nums">
                {entries.length}
              </span>
            </h2>
            <ul>
              {entries.map((entry) => {
                const name = pluginName(entry, t);
                const signal = signalFor(entry);
                return (
                  <li key={entry.id}>
                    <Button
                      variant="ghost"
                      className="sidebar-nav-item"
                      title={`${name} · ${signal.label}`}
                      aria-current={entry.id === selected ? "page" : undefined}
                      onClick={(event) =>
                        onSelect(entry.id, event.currentTarget)
                      }
                    >
                      <PluginIcon plugin={entry} size={16} />
                      <span className="min-w-0 flex-1 truncate text-start">
                        {name}
                      </span>
                      <span
                        className="plugins-status-dot ms-auto"
                        data-tone={signal.tone}
                        aria-hidden="true"
                      />
                    </Button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        {!loading && !groups.length && (
          <p role="status" className="px-2 py-1 text-xs text-muted-foreground">
            {t("plugins.noMatches")}
          </p>
        )}
      </div>
    </OverviewNavigation>
  );
}
