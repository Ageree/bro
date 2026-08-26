/** Strip the watcher `[SEEN]` marker. It never goes to the human. */

export function splitSeen(text: string): { message: string; seen?: string } {
  const lines = text.split(/\r?\n/);
  let seen: string | undefined;
  const kept: string[] = [];
  for (const line of lines) {
    const idx = line.indexOf("[SEEN]");
    if (idx !== -1 && seen === undefined) {
      seen = line.slice(idx + "[SEEN]".length).trim();
      const before = line.slice(0, idx).trimEnd();
      if (before.trim()) kept.push(before);
    } else {
      kept.push(line);
    }
  }
  return seen === undefined ? { message: text } : { message: kept.join("\n").trim(), seen };
}
