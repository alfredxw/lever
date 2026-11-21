export function parseDelimitedPreview(
  text: string,
  delimiter: "," | "\t",
  { maxRows, maxColumns, maxCellLength } = {
    maxRows: 100,
    maxColumns: 30,
    maxCellLength: 2000,
  },
) {
  const input = text.replace(/^\uFEFF/, "");
  const separator = delimiter === "," ? /[,\r\n]/g : /[\t\r\n]/g;
  const rows: string[][] = [];
  let position = 0;
  let truncated = false;

  while (position < input.length && rows.length < maxRows) {
    const row: string[] = [];
    while (true) {
      let quotedText = "";
      if (input[position] === '"') {
        position++;
        while (true) {
          const quote = input.indexOf('"', position);
          if (quote < 0) {
            quotedText += input.slice(position);
            position = input.length;
            truncated = true;
            break;
          }
          quotedText += input.slice(position, quote);
          position = quote + 1;
          if (input[position] !== '"') break;
          quotedText += '"';
          position++;
        }
      }
      separator.lastIndex = position;
      const end = separator.exec(input)?.index ?? input.length;
      const value = quotedText + input.slice(position, end);
      if (row.length < maxColumns) {
        row.push(
          value.length <= maxCellLength
            ? value
            : value.slice(0, maxCellLength).replace(/[\uD800-\uDBFF]$/, ""),
        );
      } else truncated = true;
      if (value.length > maxCellLength) truncated = true;

      position = end + 1;
      if (input[end] !== delimiter) {
        if (input.startsWith("\r\n", end)) position++;
        break;
      }
    }
    rows.push(row);
  }
  return { rows, truncated: truncated || position < input.length };
}
