type DataTransferEntry = { isDirectory?: boolean } | null | undefined;
type DataTransferItemWithEntry = Pick<
  DataTransferItem,
  "kind" | "getAsFile"
> & {
  webkitGetAsEntry?: () => DataTransferEntry;
};
type FileDragData = {
  types?: ArrayLike<string> | null;
  files?: ArrayLike<File> | null;
  items?: ArrayLike<DataTransferItemWithEntry> | null;
};

export function hasDraggedFiles(
  data: FileDragData | null | undefined,
): boolean {
  if (!data) return false;
  if ((data.files?.length ?? 0) > 0) return true;
  if (data.types && Array.from(data.types).includes("Files")) return true;
  return Array.from(data.items ?? []).some((item) => item.kind === "file");
}

export function extractDroppedFiles(data: FileDragData | null | undefined): {
  files: File[];
  skippedDirectories: number;
} {
  if (!data) return { files: [], skippedDirectories: 0 };
  const items = Array.from(data.items ?? []);
  if (items.length > 0) {
    const files: File[] = [];
    let skippedDirectories = 0;
    for (const item of items) {
      if (item.kind !== "file") continue;
      const entry = item.webkitGetAsEntry?.();
      if (entry?.isDirectory) {
        skippedDirectories++;
        continue;
      }
      const file = item.getAsFile();
      if (file) files.push(file);
    }
    if (files.length > 0 || skippedDirectories > 0) {
      return { files, skippedDirectories };
    }
  }
  return { files: Array.from(data.files ?? []), skippedDirectories: 0 };
}
