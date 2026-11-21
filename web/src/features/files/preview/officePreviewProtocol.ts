export type NotebookCell = {
  readonly kind: "markdown" | "code" | "raw";
  readonly source: string;
  readonly outputs: {
    readonly kind: "text" | "image" | "html";
    readonly text: string;
  }[];
};
export type OfficeWorkerResult =
  | {
      type: "document";
      navigation: "page" | "slide" | "chapter";
      pages: { title: string; html: string }[];
    }
  | { type: "notebook"; cells: NotebookCell[] }
  | { type: "error"; message: string }
  | {
      type: "ods";
      sheets: {
        name: string;
        rows: string[][];
        truncated: boolean;
        rowCount: number;
        columns: number;
      }[];
    };
