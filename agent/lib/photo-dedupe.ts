/** One computer photo per chat for a short window.
 *
 *  Screenshot, send_photo, exec leftovers, and path-in-text all go through
 *  sendPhotoToHuman. Without this, one «пришли скрин» becomes four copies. */

export const COMPUTER_PHOTO_COOLDOWN_MS = 45_000;
export const URL_PHOTO_COOLDOWN_MS = 20_000;

type ComputerRow = {
  at: number;
  hashes: Set<string>;
  names: Set<string>;
};

type UrlRow = { at: number; urls: Set<string> };

const computerSent = new Map<string, ComputerRow>();
const urlSent = new Map<string, UrlRow>();

export function photoFingerprint(bytes: Uint8Array): string {
  let hash = bytes.byteLength;
  const step = Math.max(1, Math.floor(bytes.byteLength / 64));
  for (let i = 0; i < bytes.byteLength; i += step) {
    hash = (Math.imul(hash, 33) ^ (bytes[i] ?? 0)) >>> 0;
  }
  const head = bytes[0] ?? 0;
  const tail = bytes[bytes.byteLength - 1] ?? 0;
  return `${bytes.byteLength}:${hash}:${head}:${tail}`;
}

export function claimComputerPhoto(input: {
  chatKey: string;
  bytes: Uint8Array;
  filename?: string;
  now?: number;
}): boolean {
  const key = input.chatKey.trim();
  if (!key) return true;
  const now = input.now ?? Date.now();
  pruneComputer(now);
  const fingerprint = photoFingerprint(input.bytes);
  const name = input.filename?.trim().toLowerCase() ?? "";
  const row = computerSent.get(key);
  if (row) {
    if (row.hashes.has(fingerprint)) return false;
    if (name && row.names.has(name)) return false;
    if (now - row.at < COMPUTER_PHOTO_COOLDOWN_MS) return false;
  }
  const next: ComputerRow = row ?? { at: now, hashes: new Set(), names: new Set() };
  next.at = now;
  next.hashes.add(fingerprint);
  if (name) next.names.add(name);
  computerSent.set(key, next);
  return true;
}

export function claimUrlPhoto(input: {
  chatKey: string;
  url: string;
  now?: number;
}): boolean {
  const key = input.chatKey.trim();
  const url = input.url.trim();
  if (!key || !url) return true;
  const now = input.now ?? Date.now();
  pruneUrls(now);
  const row = urlSent.get(key);
  if (row && row.urls.has(url) && now - row.at < URL_PHOTO_COOLDOWN_MS) {
    return false;
  }
  const next: UrlRow = row ?? { at: now, urls: new Set() };
  next.at = now;
  next.urls.add(url);
  urlSent.set(key, next);
  return true;
}

export function resetPhotoDedupe(): void {
  computerSent.clear();
  urlSent.clear();
}

function pruneComputer(now: number): void {
  for (const [key, row] of computerSent) {
    if (now - row.at > COMPUTER_PHOTO_COOLDOWN_MS) computerSent.delete(key);
  }
}

function pruneUrls(now: number): void {
  for (const [key, row] of urlSent) {
    if (now - row.at > URL_PHOTO_COOLDOWN_MS) urlSent.delete(key);
  }
}
