import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cookieHeader,
  readCookieHeader,
  writeCookieJar,
} from "../../bench/cookies.ts";

const production = new URL("https://brobro.tech");
const jar = [
  "# Netscape HTTP Cookie File",
  "#HttpOnly_brobro.tech\tFALSE\t/\tTRUE\t0\t__Secure-better-auth.session_token\tabc.def",
  "brobro.tech\tFALSE\t/\tTRUE\t1\told\texpired",
  "other.example\tFALSE\t/\tFALSE\t0\tforeign\tnope",
].join("\n");

describe("cookieHeader", () => {
  it("reads curl's jar, including HttpOnly lines, for the right host", () => {
    expect(cookieHeader(jar, production)).toBe(
      "__Secure-better-auth.session_token=abc.def"
    );
  });

  it("does not send a Secure cookie over plain HTTP", () => {
    expect(cookieHeader(jar, new URL("http://brobro.tech"))).toBeUndefined();
  });

  it("keeps a host-only cookie off subdomains", () => {
    const scoped = [
      "brobro.tech\tFALSE\t/\tTRUE\t0\thost_only\ta",
      ".brobro.tech\tTRUE\t/\tTRUE\t0\twhole_domain\tb",
    ].join("\n");

    expect(cookieHeader(scoped, production)).toBe(
      "host_only=a; whole_domain=b"
    );
    expect(cookieHeader(scoped, new URL("https://stage.brobro.tech"))).toBe(
      "whole_domain=b"
    );
  });

  it("sends a path-scoped cookie only inside its path", () => {
    const scoped = [
      "brobro.tech\tFALSE\t/foo\tTRUE\t0\tfoo\ta",
      "brobro.tech\tFALSE\t/foo/\tTRUE\t0\tfoo_slash\tb",
    ].join("\n");
    const at = (path: string) =>
      cookieHeader(scoped, new URL(path, production));

    expect(at("/foo")).toBe("foo=a");
    expect(at("/foo/bar")).toBe("foo=a; foo_slash=b");
    expect(at("/foobar")).toBeUndefined();
  });

  it("accepts a file with one Cookie header line", () => {
    expect(
      cookieHeader("Cookie: better-auth.session_token=xyz\n", production)
    ).toBe("better-auth.session_token=xyz");
  });
});

describe("writeCookieJar", () => {
  it("keeps the sign-in cookies in a file only the owner reads", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "bench-cookies-")), "c.txt");
    await writeCookieJar(path, production, [
      "__Secure-better-auth.session_token=tok.sig; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax",
    ]);

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, "utf8")).toContain("#HttpOnly_brobro.tech");
    await expect(readCookieHeader(path, production)).resolves.toBe(
      "__Secure-better-auth.session_token=tok.sig"
    );
  });

  it("fails when the sign-in set no cookie", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "bench-cookies-")), "c.txt");
    await expect(writeCookieJar(path, production, [])).rejects.toThrow(
      /session cookie/u
    );
  });
});
