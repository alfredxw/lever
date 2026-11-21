export function browserAddress(input: string) {
  const value = input.trim();
  if (!value || value.length > 8192 || /[\\\s]/.test(value)) return;
  const local = /^(?:localhost|127(?:\.\d+){3}|\[::1\])(?=[:/?#]|$)/i.test(
    value,
  );
  if (
    !/^https?:\/\//i.test(value) &&
    /^[\w+.-]+:/i.test(value) &&
    !/^[\w.-]+:\d+(?:[/?#]|$)/.test(value)
  )
    return;
  try {
    const url = new URL(
      /^https?:\/\//i.test(value)
        ? value
        : (local ? "http://" : "https://") + value,
    );
    if (
      url.hostname &&
      !url.username &&
      !url.password &&
      !value.startsWith("/")
    )
      return url.href;
  } catch {}
}
