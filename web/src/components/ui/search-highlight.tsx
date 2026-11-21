export function SearchHighlight({
  text,
  query,
}: {
  text: string;
  query: string;
}) {
  if (!query) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(escaped, "iu").exec(text);
  if (!match) return text;
  return (
    <>
      {text.slice(0, match.index)}
      <mark>{match[0]}</mark>
      {text.slice(match.index + match[0].length)}
    </>
  );
}
