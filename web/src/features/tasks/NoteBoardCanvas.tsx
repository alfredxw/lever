import { useEffect, useRef, useState } from "react";
import { Drawnix, boardToImage, base64ToBlob } from "@drawnix/drawnix";
import {
  ThemeColorMode,
  type PlaitElement,
  type PlaitBoard,
  type PlaitTheme,
  type Viewport,
} from "@plait/core";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { noteAssetURL, uploadNoteAsset } from "./noteAsset";
import type { BoardAssets } from "./NoteWhiteboard";
// The published stylesheet contains an invalid var(-default-button-size).
// Load it only while the canvas is mounted.
import drawnixStyles from "../../../node_modules/@drawnix/drawnix/index.css?raw";
import "./noteBoard.css";

type Scene = {
  elements: PlaitElement[];
  viewport?: Viewport;
  theme?: PlaitTheme;
};

// Mermaid uses a shared diagram registry and a fixed temporary SVG id.
let converting: Promise<void> = Promise.resolve();

async function openScene(
  scenePath: string | undefined,
  mermaid: string | undefined,
  signal: AbortSignal,
): Promise<Scene> {
  if (scenePath) {
    const url = noteAssetURL(scenePath, "scene.drawnix");
    if (!url) throw new Error("Invalid Drawnix scene path");
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(response.statusText);
    const scene: Scene = await response.json();
    if (
      !Array.isArray(scene?.elements) ||
      scene.elements.some(
        (element) => !element || typeof element.id !== "string",
      )
    )
      throw new Error("Invalid Drawnix scene");
    return scene;
  }
  if (mermaid) {
    const { parseMermaidToDrawnix } =
      await import("@plait-board/mermaid-to-drawnix");
    const result = converting.then(() => {
      signal.throwIfAborted();
      return parseMermaidToDrawnix(mermaid);
    });
    converting = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  return { elements: [] };
}

export default function NoteBoardCanvas({
  noteId,
  title,
  scenePath,
  mermaid,
  onSave,
  onClose,
}: {
  noteId: string;
  title: string;
  scenePath?: string;
  mermaid?: string;
  onSave: (value: BoardAssets) => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [name, setName] = useState(title || t("tasks.block.whiteboard"));
  const [scene, setScene] = useState<Scene>();
  const board = useRef<PlaitBoard>(null);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    openScene(scenePath, mermaid, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        // Drawnix reads its locale from this key when its provider mounts.
        localStorage.setItem(
          "language",
          i18n.language.startsWith("zh") ? "zh" : "en",
        );
        setScene({
          ...value,
          theme: value.theme ?? {
            themeColorMode: document.documentElement.classList.contains("dark")
              ? ThemeColorMode.dark
              : ThemeColorMode.default,
          },
        });
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(String(e));
      });
    return () => controller.abort();
  }, [scenePath, mermaid, i18n.language]);
  async function save() {
    const current = board.current;
    if (!current || saving) return;
    setSaving(true);
    setError("");
    try {
      const snapshot = {
        type: "drawnix",
        version: 1,
        source: "lever",
        elements: current.children,
        viewport: current.viewport,
        theme: current.theme,
      };
      const file = new File([JSON.stringify(snapshot)], "scene.drawnix", {
        type: "application/json",
      });
      let previewPath = "";
      if (current.children.length) {
        const png = await boardToImage(current, {
          elements: current.children,
          ratio: 2,
          fillStyle:
            current.theme.themeColorMode === ThemeColorMode.dark
              ? "#202124"
              : "#ffffff",
        });
        if (!png) throw new Error(t("tasks.board.previewError"));
        previewPath = (
          await uploadNoteAsset(
            noteId,
            new File([base64ToBlob(png)], "preview.png", { type: "image/png" }),
          )
        ).path;
      }
      const scene = await uploadNoteAsset(noteId, file);
      onSave({
        title: name.trim() || t("tasks.block.whiteboard"),
        scenePath: scene.path,
        previewPath,
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <style>
        {drawnixStyles.replaceAll(
          "var(-default-button-size)",
          "var(--default-button-size)",
        )}
      </style>
      <div className="note-board-header">
        <Input
          aria-label={t("tasks.board.title")}
          value={name}
          maxLength={150}
          onChange={(e) => setName(e.target.value)}
        />
        <Button variant="ghost" disabled={saving} onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button disabled={!ready || saving} onClick={() => void save()}>
          {t("common.save")}
        </Button>
      </div>
      {error && (
        <p role="alert" className="px-3 text-destructive">
          {error}
        </p>
      )}
      <div className="note-board-stage" inert={saving}>
        {scene && (
          <Drawnix
            value={scene.elements}
            viewport={scene.viewport}
            theme={scene.theme}
            tutorial={false}
            afterInit={(value) => {
              board.current = value;
              setReady(true);
            }}
          />
        )}
      </div>
    </>
  );
}
