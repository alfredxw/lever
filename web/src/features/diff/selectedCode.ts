import type {
  FileDiffMetadata,
  SelectedLineRange,
  SelectionSide,
} from "@pierre/diffs";

type Segment = {
  side: SelectionSide;
  start: number;
  count: number;
  index: number;
  row: number;
};

// Patch arrays omit unchanged gaps, so file line numbers are not array indexes.
export function selectedCode(
  file: FileDiffMetadata,
  range: SelectedLineRange,
  split: boolean,
) {
  const segments: Segment[] = [];
  for (const hunk of file.hunks) {
    let oldLine = hunk.deletionStart,
      newLine = hunk.additionStart;
    let row = split ? hunk.splitLineStart : hunk.unifiedLineStart;
    for (const block of hunk.hunkContent) {
      const oldCount = block.type === "context" ? block.lines : block.deletions;
      const newCount = block.type === "context" ? block.lines : block.additions;
      segments.push(
        {
          side: "deletions",
          start: oldLine,
          count: oldCount,
          index: block.deletionLineIndex,
          row,
        },
        {
          side: "additions",
          start: newLine,
          count: newCount,
          index: block.additionLineIndex,
          row: row + (split || block.type === "context" ? 0 : oldCount),
        },
      );
      oldLine += oldCount;
      newLine += newCount;
      row += split
        ? Math.max(oldCount, newCount)
        : block.type === "context"
          ? oldCount
          : oldCount + newCount;
    }
  }
  const side = range.side ?? "additions";
  const endSide = range.endSide ?? side;
  const pointRow = (line: number, side: SelectionSide) => {
    const segment = segments.find(
      (s) => s.side === side && line >= s.start && line < s.start + s.count,
    )!;
    return segment.row + line - segment.start;
  };
  const startRow = pointRow(range.start, side),
    endRow = pointRow(range.end, endSide);
  const result: {
    side: SelectionSide;
    path: string;
    start: number;
    end: number;
    text: string;
  }[] = [];
  for (const currentSide of ["deletions", "additions"] as const) {
    if (side === endSide && currentSide !== side) continue;
    for (const segment of segments.filter(
      (s) => s.side === currentSide && s.count > 0,
    )) {
      const from =
        side === endSide
          ? Math.min(range.start, range.end) - segment.start
          : Math.min(startRow, endRow) - segment.row;
      const to =
        side === endSide
          ? Math.max(range.start, range.end) - segment.start
          : Math.max(startRow, endRow) - segment.row;
      const first = Math.max(0, from),
        last = Math.min(segment.count - 1, to);
      if (first > last) continue;
      const start = segment.start + first,
        end = segment.start + last;
      const text = (
        currentSide === "deletions" ? file.deletionLines : file.additionLines
      )
        .slice(segment.index + first, segment.index + last + 1)
        .join("");
      const previous = result.at(-1);
      if (previous?.side === currentSide && previous.end + 1 === start) {
        previous.end = end;
        previous.text += text;
      } else
        result.push({
          side: currentSide,
          path:
            currentSide === "deletions"
              ? (file.prevName ?? file.name)
              : file.name,
          start,
          end,
          text,
        });
    }
  }
  return result;
}
