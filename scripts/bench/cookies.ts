import { chmod, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The benchmark signs in the way a person does and keeps the session as a
 * cookie file: the Netscape jar `curl -c` writes, which is also what the
 * README's production sign-in produces. A file holding one `name=value; …`
 * header line works too.
 */

const httpOnlyPrefix = "#HttpOnly_";

/** Where `pnpm bench verify` keeps the session: outside any repository. */
export const defaultCookieFile = join(homedir(), ".bro-bench", "cookies.txt");

/** The `Cookie` header for `host` from a jar or header file's text. */
export function cookieHeader(text: string, host: URL, now = new Date()) {
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const jarLines = lines
    .map((line) =>
      line.startsWith(httpOnlyPrefix) ? line.slice(httpOnlyPrefix.length) : line
    )
    .filter((line) => !line.startsWith("#"));
  const jar = jarLines.map((line) => line.split("\t"));
  if (jar.length > 0 && jar.every((fields) => fields.length === 7)) {
    const pairs = jar.flatMap(
      ([domain, includeSubdomains, path, secure, expires, name, value]) => {
        if (!domain || !path || !name || value === undefined) return [];
        if (!domainMatches(domain, includeSubdomains === "TRUE", host.hostname))
          return [];
        if (!pathMatches(path, host.pathname)) return [];
        if (secure === "TRUE" && host.protocol !== "https:") return [];
        const expiresAt = Number(expires);
        if (expiresAt > 0 && expiresAt * 1000 <= now.getTime()) return [];
        return [`${name}=${value}`];
      }
    );
    return pairs.length > 0 ? pairs.join("; ") : undefined;
  }
  const header = lines.find((line) => !line.startsWith("#"));
  if (header?.includes("=") !== true) return undefined;
  return header.replace(/^cookie:\s*/iu, "");
}

/** A host-only cookie (`FALSE` in the jar) goes to its exact host alone. */
function domainMatches(
  domain: string,
  includeSubdomains: boolean,
  hostname: string
) {
  const bare = domain.replace(/^\./u, "").toLowerCase();
  const host = hostname.toLowerCase();
  return host === bare || (includeSubdomains && host.endsWith(`.${bare}`));
}

/** RFC 6265 §5.1.4: `/foo` covers `/foo` and `/foo/…`, not `/foobar`. */
function pathMatches(cookiePath: string, requestPath: string) {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

/** Reads a cookie file and fails loudly when it has nothing for `host`. */
export async function readCookieHeader(path: string, host: URL) {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(
      `No cookie file at ${path}. Sign in with \`pnpm bench otp\` and \`pnpm bench verify\`, or pass --cookie-file.`,
      { cause: error }
    );
  }
  const header = cookieHeader(text, host);
  if (!header) {
    throw new Error(
      `No cookie for ${host.hostname} in ${path}. Sign in again: the session may have expired.`
    );
  }
  return header;
}

/**
 * Writes the `Set-Cookie` headers a sign-in returned as a Netscape jar that
 * only the current user can read.
 */
export async function writeCookieJar(
  path: string,
  host: URL,
  setCookies: readonly string[]
) {
  const lines = setCookies.flatMap((header) => {
    const [pair, ...attributes] = header.split(";").map((part) => part.trim());
    const separator = pair?.indexOf("=") ?? -1;
    if (!pair || separator <= 0) return [];
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    const attribute = (key: string) =>
      attributes
        .find((part) => part.toLowerCase().startsWith(`${key}=`))
        ?.slice(key.length + 1);
    const maxAge = Number(attribute("max-age"));
    const expires = Number.isFinite(maxAge)
      ? Math.floor(Date.now() / 1000) + maxAge
      : Math.floor(Date.parse(attribute("expires") ?? "") / 1000) || 0;
    const httpOnly = attributes.some(
      (part) => part.toLowerCase() === "httponly"
    );
    const secure = attributes.some((part) => part.toLowerCase() === "secure");
    return [
      [
        `${httpOnly ? httpOnlyPrefix : ""}${host.hostname}`,
        "FALSE",
        attribute("path") ?? "/",
        secure ? "TRUE" : "FALSE",
        String(expires),
        name,
        value,
      ].join("\t"),
    ];
  });
  if (lines.length === 0) {
    throw new Error("The sign-in answered without a session cookie.");
  }
  await writeFile(path, `# Netscape HTTP Cookie File\n${lines.join("\n")}\n`, {
    mode: 0o600,
  });
  // `mode` applies only when the file is created; a reused path keeps its old
  // permissions otherwise.
  await chmod(path, 0o600);
}
