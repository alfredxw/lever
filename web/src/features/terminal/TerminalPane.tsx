import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type Ref,
} from "react";
import { useTranslation } from "react-i18next";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import "@xterm/xterm/css/xterm.css";

type Status =
  | { type: "connecting" | "reconnecting" | "ready" | "disconnected" | "ended" }
  | { type: "exited"; code: number }
  | { type: "error"; message: string };

export type TerminalResult =
  | { type: "exited"; code: number }
  | { type: "ended" | "disconnected" }
  | { type: "error"; message: string };

function theme() {
  const css = getComputedStyle(document.documentElement);
  const background = css.getPropertyValue("--background").trim();
  const foreground = css.getPropertyValue("--foreground").trim();
  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: css.getPropertyValue("--accent").trim(),
  };
}

export default function TerminalPane({
  path,
  terminalId,
  started,
  closing,
  onStarted,
  onRestart,
  dark,
  ref,
  style,
  selected,
  onSelect,
  readOnly = false,
  onResult,
}: {
  path: string;
  terminalId: string;
  started: boolean;
  closing: boolean;
  onStarted?: () => void;
  onRestart?: () => Promise<void>;
  dark?: boolean;
  ref?: Ref<() => void>;
  style: CSSProperties;
  selected: boolean;
  onSelect?: () => void;
  readOnly?: boolean;
  onResult?: (result: TerminalResult) => void;
}) {
  const { t } = useTranslation();
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef<XTerm | null>(null);
  const startedRef = useRef(started);
  const notifyStarted = useRef(onStarted);
  notifyStarted.current = onStarted;
  const notifyResult = useRef(onResult);
  notifyResult.current = onResult;
  const [attempt, setAttempt] = useState(0);
  const [restarting, setRestarting] = useState(false);
  const [trimmed, setTrimmed] = useState(false);
  const [status, setStatus] = useState<Status>({ type: "connecting" });
  useImperativeHandle(ref, () => () => terminal.current?.focus(), []);

  useLayoutEffect(() => {
    const element = container.current!;
    const term = new XTerm({
      cursorBlink: true,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      minimumContrastRatio: 4.5,
      scrollback: 5000,
      theme: theme(),
      screenReaderMode: true,
      allowProposedApi: false,
      disableStdin: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    terminal.current = term;
    let socket: WebSocket | undefined;
    let timer: number | undefined;
    let disposed = false;
    let writable = false;
    let finished = false;
    let applyingSize = false;
    let reconnectSince: number | undefined;
    let requestedSize = { cols: term.cols, rows: term.rows };
    const result = (value: TerminalResult) => {
      setStatus(value);
      notifyResult.current?.(value);
    };
    const send = (message: object) => {
      if (socket?.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify(message));
    };
    const input = (data: Uint8Array) => {
      if (readOnly || !writable || socket?.readyState !== WebSocket.OPEN)
        return;
      if (socket.bufferedAmount + data.byteLength > 1 << 20) {
        socket.close();
        return;
      }
      for (let offset = 0; offset < data.byteLength; offset += 16 << 10) {
        socket.send(data.slice(offset, offset + (16 << 10)));
      }
    };
    const encoder = new TextEncoder();
    term.onData((data) => input(encoder.encode(data)));
    term.onBinary((data) =>
      input(Uint8Array.from(data, (char) => char.charCodeAt(0))),
    );
    function applySize(cols: number, rows: number) {
      applyingSize = true;
      term.resize(cols, rows);
      applyingSize = false;
    }
    const resize = () => {
      if (applyingSize || !element.clientWidth || !element.clientHeight) return;
      const size = fit.proposeDimensions();
      if (!size) return;
      requestedSize = {
        cols: Math.max(2, Math.min(size.cols, 500)),
        rows: Math.max(1, Math.min(size.rows, 300)),
      };
      if (writable) send({ type: "resize", ...requestedSize });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    const themeObserver = readOnly
      ? new MutationObserver(() => {
          term.options.theme = theme();
        })
      : undefined;
    themeObserver?.observe(document.documentElement, {
      attributeFilter: ["class"],
    });

    function connect() {
      if (disposed) return;
      resize();
      const url = new URL(`/api${path}`, location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("terminalId", terminalId);
      if (!readOnly && !startedRef.current) url.searchParams.set("start", "1");
      url.searchParams.set("cols", String(requestedSize.cols));
      url.searchParams.set("rows", String(requestedSize.rows));
      const connection = new WebSocket(url);
      socket = connection;
      connection.binaryType = "arraybuffer";
      const active = () => !disposed && socket === connection;
      // Control frames must run in the same xterm queue as output bytes.
      const afterOutput = (action: () => void) =>
        term.write(new Uint8Array(), () => {
          if (active()) action();
        });
      connection.onmessage = ({ data }: MessageEvent<string | ArrayBuffer>) => {
        if (!active()) return;
        if (data instanceof ArrayBuffer) {
          term.write(new Uint8Array(data), () => {
            if (active()) send({ type: "ack" });
          });
          return;
        }
        const message = JSON.parse(data) as
          | { type: "replay"; cols: number; rows: number; trimmed: boolean }
          | { type: "size"; cols: number; rows: number }
          | { type: "ready" }
          | { type: "ended" }
          | { type: "busy" }
          | { type: "exit"; code: number }
          | { type: "error"; message: string };
        switch (message.type) {
          case "replay":
            setTrimmed(message.trimmed);
            if (!startedRef.current) {
              startedRef.current = true;
              notifyStarted.current?.();
            }
            // Cancel an incomplete control string on the old socket, then
            // reset in-band so xterm also clears its escape parser.
            term.write("\x18\x1bc", () => {
              if (active()) applySize(message.cols, message.rows);
            });
            break;
          case "size":
            afterOutput(() => applySize(message.cols, message.rows));
            break;
          case "ready":
            afterOutput(() => {
              if (connection.readyState !== WebSocket.OPEN || finished) return;
              writable = true;
              reconnectSince = undefined;
              term.options.disableStdin = readOnly;
              send({ type: "resize", ...requestedSize });
              setStatus({ type: "ready" });
            });
            break;
          case "busy":
            break; // The previous connection is still being released.
          default:
            finished = true;
            writable = false;
            term.options.disableStdin = true;
            afterOutput(() =>
              result(
                message.type === "exit"
                  ? { type: "exited", code: message.code }
                  : message,
              ),
            );
        }
      };
      connection.onclose = (event) => {
        if (!active() || finished) return;
        writable = false;
        term.options.disableStdin = true;
        if (event.code === 1000 && event.reason === "terminal ended") {
          result({ type: "ended" });
          return;
        }
        reconnectSince ??= performance.now();
        if (performance.now() - reconnectSince >= 20_000) {
          result({ type: "disconnected" });
          return;
        }
        setStatus({ type: "reconnecting" });
        timer = window.setTimeout(connect, 500);
      };
    }
    setStatus({ type: startedRef.current ? "reconnecting" : "connecting" });
    // The StrictMode mount probe ends before this frame can start a shell.
    const frame = requestAnimationFrame(connect);
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      observer.disconnect();
      themeObserver?.disconnect();
      socket?.close();
      term.dispose();
      terminal.current = null;
    };
  }, [path, terminalId, attempt, readOnly]);

  useEffect(() => {
    terminal.current?.textarea?.setAttribute(
      "aria-label",
      t(readOnly ? "worktrees.setupOutput" : "terminal.input"),
    );
  }, [t, attempt, readOnly]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (terminal.current) terminal.current.options.theme = theme();
    });
    return () => cancelAnimationFrame(frame);
  }, [dark, attempt]);

  async function restart() {
    if (!onRestart || restarting || closing) return;
    if (status.type === "disconnected") {
      setAttempt((value) => value + 1);
      requestAnimationFrame(() => terminal.current?.focus());
      return;
    }
    setRestarting(true);
    try {
      await onRestart();
    } catch (error) {
      toast.error(String(error));
    } finally {
      setRestarting(false);
    }
  }

  return (
    <div
      className="terminal-pane"
      data-selected={selected}
      style={style}
      onPointerDown={onSelect}
      onFocus={onSelect}
    >
      <div className="terminal-surface" ref={container} />
      {trimmed && status.type === "ready" && (
        <span className="terminal-status" role="status">
          {t("terminal.historyTrimmed")}
        </span>
      )}
      {!readOnly && status.type !== "ready" && (
        <div className="terminal-status">
          <span role={status.type === "error" ? "alert" : "status"}>
            {status.type === "exited"
              ? t("terminal.exited", { code: status.code })
              : status.type === "error"
                ? status.message
                : t(`terminal.${status.type}`)}
          </span>
          {onRestart &&
            status.type !== "connecting" &&
            status.type !== "reconnecting" && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={restarting || closing}
                onClick={restart}
              >
                <RotateCcw aria-hidden="true" />
                {t(
                  status.type === "disconnected"
                    ? "terminal.reconnect"
                    : "terminal.restart",
                )}
              </Button>
            )}
        </div>
      )}
    </div>
  );
}
