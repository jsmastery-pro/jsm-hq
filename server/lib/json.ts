/**
 * Parses a CLI's JSON output, ignoring anything printed before or after it
 * (sbx can add a notice, e.g. about an update, to the same output). Null when
 * there's no valid JSON object in it.
 */
export function parseCliJson<T>(text: string): T | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
