import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  ExternalLink,
  Globe,
  Maximize2,
  Minus,
  MoreVertical,
  PictureInPicture2,
  Plus,
  RotateCcw,
  RotateCw,
  MousePointer2,
  Smartphone,
  X,
} from "lucide-react";
import { isMyGo } from "mygo-runtime";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  Browser,
  events,
  type BrowserElement,
  type BrowserState,
} from "@/api/desktop.gen";
import type { WorkspaceTab } from "@/components/workbench/useWorkspaces";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useEventCallback } from "@/hooks/useEventCallback";
import { browserAddress } from "./browserAddress";
import { trackBrowserSurface } from "./browserSurface";
import "./browser.css";

type BrowserTab = Extract<WorkspaceTab, { kind: "browser" }>;
export type BrowserContext = { element: BrowserElement } | { file: File };
const zoomLevels = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

export default function BrowserPanel({
  tab,
  agent,
  visible,
  floating,
  onFloat,
  onLocation,
  onFocus,
  onAdd,
}: {
  tab: BrowserTab;
  agent: string;
  visible: boolean;
  floating: boolean;
  onFloat: (value: boolean) => void;
  onLocation: (url: string, title: string) => void;
  onFocus: () => void;
  onAdd?: (context: BrowserContext) => void;
}) {
  const { t } = useTranslation();
  const desktop = isMyGo();
  const slot = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const initialURL = useRef(tab.url ?? "");
  const [state, setState] = useState<BrowserState>();
  const [fault, setFault] = useState("");
  const [draft, setDraft] = useState<string | null>(null);
  const [picked, setPicked] = useState<BrowserElement | null>(null);
  const picking = useRef(0);
  const [pickActive, setPickActive] = useState(false);
  const [clear, setClear] = useState<"clearCookies" | "clearCache">();
  const [device, setDevice] = useState(false);
  const [size, setSize] = useState([390, 844]);
  const [menu, setMenu] = useState(false);
  const [menuImage, setMenuImage] = useState("");
  const menuGeneration = useRef(0);
  const captureGeneration = useRef(0);
  const shown = visible || floating;
  const [retry, setRetry] = useState(0);
  const address = state?.url || tab.url || "";
  const loaded = !!state?.url && !state.error;
  const update = useEventCallback((next: BrowserState) => {
    setState(next);
    if (next.url)
      onLocation(
        next.url,
        next.title ||
          (browserAddress(next.url) && new URL(next.url).host) ||
          next.url,
      );
  });
  const focused = useEventCallback(onFocus);
  const cancel = useEventCallback(() => {
    picking.current++;
    setPickActive(false);
    if (pickActive) void Browser.cancelPick(tab.id).catch(() => {});
  });
  useEffect(() => {
    if (!desktop) return;
    let live = true;
    let received = false;
    const off = events.leverBrowserChanged.on((next) => {
      if (next.id === tab.id && live) {
        received = true;
        update(next);
      }
    });
    const offPress = events.leverBrowserPressed.on((id) => {
      if (id === tab.id) focused();
    });
    setFault("");
    void Browser.open(agent, tab.id, initialURL.current).then(
      (next) => {
        if (live && !received) update(next);
      },
      (error) => {
        if (live) setFault(String(error));
      },
    );
    return () => {
      live = false;
      off();
      offPress();
    };
  }, [agent, desktop, tab.id, retry, focused, update]);
  const addToDraft = useEventCallback((context: BrowserContext) => {
    if (shown) onAdd?.(context);
  });
  useLayoutEffect(
    () => () => {
      captureGeneration.current++;
    },
    [shown, tab.id],
  );
  useLayoutEffect(() => {
    if (!shown || !desktop || !loaded || !slot.current || menu || clear) return;
    return trackBrowserSurface(tab.id, slot.current, device ? size : undefined);
  }, [desktop, shown, loaded, tab.id, menu, clear, floating, device, size]);
  useEffect(() => {
    if (!shown || !desktop) return;
    return () => {
      cancel();
    };
  }, [shown, desktop, tab.id, cancel]);
  useEffect(() => {
    if (shown && !address) input.current?.focus();
  }, [shown, address]);
  const error = (reason: unknown) => toast.error(String(reason));
  const command = (action: string, value = "") =>
    Browser.command(tab.id, action, value).catch(error);
  function navigate() {
    const url = browserAddress(draft ?? address);
    if (!url) {
      toast.error(t("browser.invalid"));
      input.current?.focus();
      return;
    }
    if (!desktop) {
      window.open(url, "_blank", "noopener,noreferrer");
      onLocation(url, new URL(url).host);
    } else {
      setPicked(null);
      void command("navigate", url);
    }
    setDraft(null);
    input.current?.blur();
  }
  async function selectElement() {
    if (pickActive) {
      cancel();
      return;
    }
    const generation = ++picking.current;
    setPickActive(true);
    setPicked(null);
    try {
      const element = await Browser.pick(tab.id);
      if (picking.current === generation) setPicked(element);
    } catch (reason) {
      if (picking.current === generation) error(reason);
    } finally {
      if (picking.current === generation) setPickActive(false);
    }
  }
  async function capture() {
    const generation = captureGeneration.current;
    try {
      const png = await Browser.screenshot(tab.id);
      if (captureGeneration.current !== generation) return;
      const bytes = Uint8Array.from(atob(png), (char) => char.charCodeAt(0));
      const file = new File([bytes], "screenshot.png", { type: "image/png" });
      addToDraft({ file });
    } catch (reason) {
      error(reason);
    }
  }
  function changeMenu(open: boolean) {
    const generation = ++menuGeneration.current;
    setMenuImage("");
    setMenu(open);
    if (open && loaded)
      void Browser.screenshot(tab.id)
        .then((data) => {
          if (menuGeneration.current === generation)
            setMenuImage("data:image/png;base64," + data);
        })
        .catch(() => {});
  }
  function icon(
    label: string,
    Icon: typeof Globe,
    action: () => void,
    disabled = false,
    className?: string,
    pressed?: boolean,
  ) {
    return (
      <Button
        type="button"
        size="icon-sm"
        variant={pressed ? "secondary" : "ghost"}
        aria-label={label}
        title={label}
        disabled={disabled}
        className={className}
        aria-pressed={pressed}
        onClick={action}
      >
        <Icon />
      </Button>
    );
  }
  const zoom = state?.zoom ?? 1;
  const screen = (
    <section
      className={floating ? "browser-panel browser-float" : "browser-panel"}
      aria-label={t("workspace.browser")}
    >
      <form
        className="browser-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          navigate();
        }}
      >
        {desktop && (
          <>
            {icon(
              t("browser.back"),
              ArrowLeft,
              () => void command("back"),
              !state?.back,
              "browser-history",
            )}
            {icon(
              t("browser.forward"),
              ArrowRight,
              () => void command("forward"),
              !state?.forward,
              "browser-history",
            )}
            {icon(
              t(state?.loading ? "browser.stop" : "browser.reload"),
              state?.loading ? X : RotateCw,
              () => void command(state?.loading ? "stop" : "reload"),
              !address,
              "browser-history",
            )}
          </>
        )}
        <Input
          ref={input}
          className="browser-address"
          value={draft ?? address}
          spellCheck={false}
          autoComplete="off"
          aria-label={t("browser.address")}
          placeholder={t("browser.address")}
          onFocus={(event) => {
            event.currentTarget.select();
          }}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setDraft(null);
              event.currentTarget.blur();
            }
            if (
              event.key === "Enter" &&
              (event.nativeEvent.isComposing ||
                event.nativeEvent.keyCode === 229)
            )
              event.preventDefault();
          }}
        />
        {!desktop ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("browser.external")}
            title={t("browser.external")}
            type="submit"
          >
            <ExternalLink />
          </Button>
        ) : (
          <>
            {icon(
              t(pickActive ? "browser.cancelPick" : "browser.pick"),
              MousePointer2,
              () => void selectElement(),
              !loaded || !onAdd,
              undefined,
              pickActive,
            )}
            {icon(
              t("browser.capture"),
              Camera,
              () => void capture(),
              !loaded || !onAdd,
              "browser-secondary",
            )}
            {icon(
              t(floating ? "browser.dock" : "browser.float"),
              floating ? Maximize2 : PictureInPicture2,
              () => onFloat(!floating),
              !loaded,
              "browser-secondary",
              floating,
            )}
            <DropdownMenu open={menu} onOpenChange={changeMenu}>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  title={t("browser.more")}
                  aria-label={t("browser.more")}
                >
                  <MoreVertical />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-52">
                <div
                  className="browser-overflow"
                  data-narrow={
                    (slot.current?.parentElement &&
                      slot.current.parentElement.clientWidth < 440) ||
                    undefined
                  }
                >
                  <DropdownMenuItem
                    disabled={!state?.back}
                    onSelect={() => void command("back")}
                  >
                    {t("browser.back")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!state?.forward}
                    onSelect={() => void command("forward")}
                  >
                    {t("browser.forward")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!address}
                    onSelect={() =>
                      void command(state?.loading ? "stop" : "reload")
                    }
                  >
                    {t(state?.loading ? "browser.stop" : "browser.reload")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!loaded || !onAdd}
                    onSelect={() => void capture()}
                  >
                    {t("browser.capture")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!loaded}
                    onSelect={() => onFloat(!floating)}
                  >
                    {t(floating ? "browser.dock" : "browser.float")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </div>
                <DropdownMenuItem
                  disabled={!address}
                  onSelect={() => void command("hardReload")}
                >
                  {t("browser.hardReload")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!loaded}
                  onSelect={() => void command("inspect")}
                >
                  {t("browser.inspect")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!loaded}
                  onSelect={() => void command("window")}
                >
                  {t("browser.window")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!loaded}
                  onSelect={() => setDevice(!device)}
                >
                  {t(device ? "browser.hideDevice" : "browser.device")}
                </DropdownMenuItem>
                {state?.appearance && (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger disabled={!loaded}>
                      {t("settings.appearance")}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      <DropdownMenuRadioGroup
                        value={state.appearance}
                        onValueChange={(value) =>
                          void command("appearance", value)
                        }
                      >
                        {(["system", "light", "dark"] as const).map((value) => (
                          <DropdownMenuRadioItem key={value} value={value}>
                            {t(`settings.${value}`)}
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                )}
                <DropdownMenuSeparator />
                <div className="flex items-center gap-1 px-1.5 text-control">
                  <span className="mr-auto">{t("browser.zoom")}</span>
                  {icon(
                    t("browser.zoomOut"),
                    Minus,
                    () =>
                      void command(
                        "zoom",
                        String(
                          zoomLevels.filter((level) => level < zoom).at(-1),
                        ),
                      ),
                    !loaded || zoom <= 0.5,
                  )}
                  <span className="tabular-nums">
                    {Math.round(zoom * 100)}%
                  </span>
                  {icon(
                    t("browser.zoomIn"),
                    Plus,
                    () =>
                      void command(
                        "zoom",
                        String(zoomLevels.find((level) => level > zoom)),
                      ),
                    !loaded || zoom >= 3,
                  )}
                  {icon(
                    t("browser.resetZoom"),
                    RotateCcw,
                    () => void command("zoom", "1"),
                    !loaded || zoom === 1,
                  )}
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>{t("browser.profile")}</DropdownMenuLabel>
                {(["clearCookies", "clearCache"] as const).map((kind) => (
                  <DropdownMenuItem
                    key={kind}
                    disabled={!state}
                    onSelect={() => setClear(kind)}
                  >
                    {t(`browser.${kind}`)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </form>
      {device && (
        <div className="browser-device">
          <Smartphone size={15} />
          <select
            aria-label={t("browser.devicePreset")}
            value={size.join("x")}
            onChange={(event) =>
              setSize(event.target.value.split("x").map(Number))
            }
          >
            {!["390x844", "768x1024", "1280x800"].includes(size.join("x")) && (
              <option value={size.join("x")}>{t("browser.custom")}</option>
            )}
            <option value="390x844">{t("browser.phone")}</option>
            <option value="768x1024">{t("browser.tablet")}</option>
            <option value="1280x800">{t("browser.laptop")}</option>
          </select>
          {size.map((value, index) => (
            <Input
              key={index + ":" + value}
              type="number"
              min={120}
              max={4096}
              aria-label={t(index ? "browser.height" : "browser.width")}
              defaultValue={value}
              onBlur={(event) => {
                const number = Number(event.target.value);
                if (Number.isInteger(number) && number >= 120 && number <= 4096)
                  setSize(
                    size.map((old, axis) => (axis === index ? number : old)),
                  );
                else event.target.value = String(value);
              }}
            />
          ))}
          {icon(t("browser.rotate"), RotateCw, () =>
            setSize([size[1], size[0]]),
          )}
          {icon(t("browser.hideDevice"), X, () => setDevice(false))}
        </div>
      )}
      {picked && (
        <div className="browser-selection">
          <MousePointer2 size={15} />
          <span title={picked.selector}>
            {picked.tag} {picked.text}
          </span>
          <Button
            size="sm"
            disabled={!onAdd}
            onClick={() => {
              onAdd?.({ element: picked });
              setPicked(null);
            }}
          >
            {t("files.addToChat")}
          </Button>
          {icon(t("common.cancel"), X, () => setPicked(null))}
        </div>
      )}
      <div className="browser-canvas">
        <div
          ref={slot}
          className="browser-surface"
          style={
            device
              ? {
                  aspectRatio: size.join(" / "),
                  width: `min(100%, ${size[0]}px, calc(100cqh * ${size[0] / size[1]}))`,
                  height: "auto",
                  alignSelf: "start",
                }
              : undefined
          }
        >
          {menuImage && <img src={menuImage} alt="" />}
          {(!desktop || !address || state?.error || fault) && (
            <div className="browser-empty">
              <Globe size={24} />
              <p>
                {fault ||
                  state?.error ||
                  t(desktop ? "browser.address" : "browser.webHint")}
              </p>
              {(fault || state?.error) && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    fault ? setRetry(retry + 1) : void command("reload")
                  }
                >
                  {t("browser.reload")}
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
      <Dialog
        open={!!clear}
        onOpenChange={(open) => {
          if (!open) setClear(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{clear && t(`browser.${clear}`)}</DialogTitle>
            <DialogDescription>{t("browser.clearScope")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setClear(undefined)}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => {
                if (clear) void command(clear);
                setClear(undefined);
              }}
            >
              {t("browser.clear")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
  return floating ? createPortal(screen, document.body) : screen;
}
