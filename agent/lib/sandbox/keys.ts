import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { env } from "@shared/environment";

/**
 * The keys and names of the code sandbox (`sandbox/README.md`) that Bro
 * derives from SANDBOX_SIGNING_KEY instead of storing: the host's token key,
 * the tool router's token key, a sandbox's id and its snapshot key.
 */

/** `sandboxd` refuses a token that lives longer than this. */
const maximumHostTokenSeconds = 15 * 60;
/** The tool router's token rides along with every turn's sandbox request. */
export const maximumToolsTokenSeconds = 6 * 60 * 60;

function signingKey() {
  const key = env.SANDBOX_SIGNING_KEY;
  if (key === undefined)
    throw new Error("SANDBOX_SIGNING_KEY is not configured.");
  return Buffer.from(key, "hex");
}

function derived(label: string) {
  return createHmac("sha256", signingKey()).update(label).digest();
}

/**
 * The key one host's `sandboxd` checks tokens with, as `/etc/bro/sandboxd.json`
 * holds it: HMAC-SHA256 of SANDBOX_SIGNING_KEY and `bro-sandbox-host:<host id>`.
 */
export function sandboxHostKey(hostId: string) {
  return derived(`bro-sandbox-host:${hostId}`);
}

/** What a host token says: which host it opens, and until when. */
interface HostTokenPayload {
  readonly env: string;
  readonly exp: number;
}

/** What a tool router token says: whose sandbox, and until when. */
interface ToolsTokenPayload {
  readonly exp: number;
  readonly sb: string;
  readonly ws: string;
}

function sign(key: Buffer, payload: HostTokenPayload | ToolsTokenPayload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signed = `v1.${body}`;
  const signature = createHmac("sha256", key)
    .update(signed)
    .digest("base64url");
  return `${signed}.${signature}`;
}

/**
 * A short-lived bearer token for the host's `sandboxd`: the format of
 * `hostd`'s (`verify_token` in `browser-vm/host/hostd.py`), whose payload's
 * keys and their order are part of the signed bytes.
 */
export function signSandboxHostToken(
  hostId: string,
  ttlSeconds = 300,
  now = Date.now()
) {
  if (
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds <= 0 ||
    ttlSeconds > maximumHostTokenSeconds
  ) {
    throw new Error("A sandbox host token lives 1 second to 15 minutes.");
  }
  return sign(sandboxHostKey(hostId), {
    env: hostId,
    exp: Math.floor(now / 1_000) + ttlSeconds,
  });
}

function toolsKey() {
  return derived("bro-sandbox-tools");
}

/**
 * The token `sandboxd` adds to a sandbox's calls to the tool router. The
 * sandbox never holds it: it opens only the router's tools, for this
 * workspace, until it expires.
 */
export function signSandboxToolsToken(input: {
  readonly now?: number;
  readonly sandboxId: string;
  readonly ttlSeconds?: number;
  readonly workspaceId: string;
}) {
  const ttlSeconds = input.ttlSeconds ?? maximumToolsTokenSeconds;
  if (
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds <= 0 ||
    ttlSeconds > maximumToolsTokenSeconds
  ) {
    throw new Error("A sandbox tools token lives 1 second to 6 hours.");
  }
  return sign(toolsKey(), {
    sb: input.sandboxId,
    ws: input.workspaceId,
    exp: Math.floor((input.now ?? Date.now()) / 1_000) + ttlSeconds,
  });
}

const toolsClaimsSchema = z.object({
  exp: z.number(),
  sb: z.string().min(1),
  ws: z.string(),
});

const tokenJsonSchema = z
  .string()
  .transform((text, context) => {
    try {
      return z.json().parse(JSON.parse(text));
    } catch {
      context.addIssue({ code: "custom", message: "not JSON" });
      return z.NEVER;
    }
  })
  .pipe(toolsClaimsSchema);

/**
 * The claims of a valid tool router token, or undefined: a bad signature, a
 * malformed payload and an expired or overlong token all read the same.
 */
export function verifySandboxToolsToken(token: string, now = Date.now()) {
  const [version, body, signature, ...rest] = token.split(".");
  if (
    version !== "v1" ||
    body === undefined ||
    signature === undefined ||
    rest.length > 0
  ) {
    return undefined;
  }
  const expected = createHmac("sha256", toolsKey())
    .update(`v1.${body}`)
    .digest();
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length) return undefined;
  if (!timingSafeEqual(given, expected)) return undefined;
  const claims = tokenJsonSchema.safeParse(
    Buffer.from(body, "base64url").toString("utf8")
  );
  if (!claims.success) return undefined;
  const nowSeconds = now / 1_000;
  const { exp } = claims.data;
  if (exp <= nowSeconds || exp > nowSeconds + maximumToolsTokenSeconds) {
    return undefined;
  }
  return claims.data;
}

/**
 * A sandbox's id on the host: `sandboxd` takes only `[a-z0-9-]{1,63}`, and
 * eve's session keys carry other characters, so it is `sb-` and 40 hex of
 * the key's SHA-256. The same session always gets the same sandbox.
 */
export function sandboxIdFor(sessionKey: string) {
  return `sb-${createHash("sha256").update(sessionKey).digest("hex").slice(0, 40)}`;
}

/**
 * The key a sandbox's snapshots are sealed with, as 64 hex characters:
 * HKDF-SHA256 of SANDBOX_SIGNING_KEY with the sandbox id as its info. It
 * goes with each request and lives only in `sandboxd`'s memory.
 */
export function sandboxSnapshotKey(sandboxId: string) {
  return Buffer.from(
    hkdfSync(
      "sha256",
      signingKey(),
      Buffer.alloc(0),
      Buffer.from(`bro-sandbox-snapshot:${sandboxId}`, "utf8"),
      32
    )
  ).toString("hex");
}

/**
 * The key a shared file's link is signed with: the link opens that one
 * object and nothing else (`app/sandbox-files`).
 */
export function sandboxFileLinkSignature(objectKey: string) {
  return createHmac("sha256", derived("bro-sandbox-file-links"))
    .update(objectKey)
    .digest("base64url");
}
