import { createHash, randomUUID } from "node:crypto";
import type { SandboxSession } from "eve/sandbox";
import { z } from "zod";
import { taskFilesShareBytes } from "@agent/lib/sandbox/files";
import { runFreshKit } from "@agent/lib/sandbox/kit";
// eve takes only modules under agent/lib, so the signing assets live beside
// the kit; its asset plugin inlines a relative import as a data URL.
import handFontDataUrl from "../../../sandbox/signature/marck-script.ttf?inline";
import typedPreviewDataUrl from "../../../sandbox/signature/typed-preview.pdf?inline";

/**
 * The kit's three signing commands in Bro's own sandbox (W2's `brokit`):
 * `img signature` cuts the signature out of the person's photo, `pdf
 * sign-places` lists where a PDF can be signed, `pdf stamp-sign` puts the
 * signature and the date there. bro-eve never parses a PDF or decodes an
 * image itself: a hostile file costs the sandbox, not the server. Each call
 * gets a directory of its own under /tmp with a fresh copy of the kit
 * (`runFreshKit`), and the kit reads only the copy of the document written
 * there, the bytes this side hashed.
 */

type SignSandbox = Pick<
  SandboxSession,
  "readBinaryFile" | "removePath" | "run" | "writeBinaryFile" | "writeTextFile"
>;

const dataUrlBytes = (url: string) =>
  new Uint8Array(Buffer.from(url.slice(url.indexOf(",") + 1), "base64"));

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** A refusal of the kit: exit 2 with its code. */
const refusalSchema = z.object({ code: z.string(), ok: z.literal(false) });

const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The PNG's width and height from its IHDR, when it is a PNG. */
function pngSize(bytes: Uint8Array) {
  if (
    bytes.byteLength < 24 ||
    pngSignature.some((byte, at) => bytes[at] !== byte) ||
    Buffer.from(bytes.subarray(12, 16)).toString("latin1") !== "IHDR"
  ) {
    return undefined;
  }
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { height: view.readUInt32BE(20), width: view.readUInt32BE(16) };
}

const startsPdf = (bytes: Uint8Array) =>
  Buffer.from(bytes.subarray(0, 5)).toString("latin1") === "%PDF-";

/**
 * Runs `work` with a directory made for it alone, and removes the directory
 * however it ends: `/tmp` is not in the sandbox's snapshot either way.
 */
async function inFreshDir<T>(
  sandbox: SignSandbox,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  work: (dir: string, signal: AbortSignal) => Promise<T>
) {
  const dir = `/tmp/bro-sign-${randomUUID()}`;
  const timeout = AbortSignal.timeout(timeoutMs);
  const bounded =
    signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  try {
    return await work(dir, bounded);
  } finally {
    await Promise.resolve(
      sandbox.removePath({ force: true, path: dir, recursive: true })
    ).catch(() => undefined);
  }
}

/**
 * The kit's answer to one command, or "unavailable" when the kit did not
 * start (`runFreshKit` throws on a boot failure, or the sandbox failed).
 */
async function kit(
  sandbox: SignSandbox,
  dir: string,
  args: readonly string[],
  signal: AbortSignal,
  timeoutMs: number
) {
  try {
    return await runFreshKit(sandbox, dir, args, { signal, timeoutMs });
  } catch {
    return "unavailable" as const;
  }
}

const signatureCodes = ["no_ink", "unclear", "unreadable"] as const;

/** A photo eve staged from the person's message, and nothing else. */
const stagedPhoto = /^\/workspace\/attachments\/[\da-f]{16}\/[\w.-]{1,255}$/u;

/**
 * The person's signature from their photo (a staged attachment path, which
 * travels in the kit's arguments, never through a shell): a transparent PNG
 * of the ink within stamp-sign's own limits, and the preview the person is
 * shown. `no_ink`, `unclear` and `unreadable` are the photo's fault;
 * `unavailable` the sandbox's or the kit's.
 */
export async function extractSignature(
  sandbox: SignSandbox,
  photoPath: string,
  signal?: AbortSignal
): Promise<
  | {
      readonly kind: "ok";
      readonly png: Uint8Array;
      readonly preview: Uint8Array;
      readonly sha256: string;
    }
  | {
      readonly kind: "no_ink" | "unavailable" | "unclear" | "unreadable";
    }
> {
  if (!stagedPhoto.test(photoPath)) return { kind: "unreadable" };
  const timeoutMs = 60_000;
  return await inFreshDir(sandbox, signal, timeoutMs, async (dir, bounded) => {
    const output = `${dir}/sig.png`;
    const preview = `${dir}/preview.png`;
    const result = await kit(
      sandbox,
      dir,
      ["img", "signature", photoPath, "-o", output, "--preview", preview],
      bounded,
      timeoutMs
    );
    if (result === "unavailable") return { kind: "unavailable" };
    if (result.exitCode === 2) {
      const code = refusalSchema.safeParse(result.json).data?.code;
      return {
        kind: signatureCodes.find((known) => known === code) ?? "unreadable",
      };
    }
    if (result.exitCode !== 0) return { kind: "unavailable" };
    const [png, shown] = await Promise.all([
      sandbox.readBinaryFile({ abortSignal: bounded, path: output }),
      sandbox.readBinaryFile({ abortSignal: bounded, path: preview }),
    ]);
    const size = png === null ? undefined : pngSize(png);
    if (
      png === null ||
      shown === null ||
      size === undefined ||
      png.byteLength > 1024 * 1024 ||
      size.width > 4000 ||
      size.height > 400 ||
      pngSize(shown) === undefined ||
      shown.byteLength > 2 * 1024 * 1024
    ) {
      return { kind: "unavailable" };
    }
    return { kind: "ok", png, preview: shown, sha256: sha256(png) };
  });
}

/** One widget the kit found a signing place in (W2's `sign-places`). */
const placeSchema = z.object({
  bro: z
    .object({
      n: z.number().int(),
      role: z.enum(["signature", "initials", "date"]),
    })
    .nullable(),
  empty: z.boolean(),
  field: z.string().min(1),
  hidden: z.boolean(),
  hint: z.string().nullable(),
  label: z.string(),
  marked: z.boolean(),
  page: z.number().int().min(1),
  type: z.string(),
});

const inventorySchema = z.object({
  ok: z.literal(true),
  pages: z.number().int().nonnegative(),
  // The kit leaves the places out when there are too many to list.
  places: z.array(placeSchema).default([]),
  signed_by_bro: z.boolean(),
  signed_fields: z.array(z.string()),
  status: z.enum(["ok", "encrypted", "xfa", "too_many"]),
});

export type PlaceInventory = z.infer<typeof inventorySchema>;

/**
 * Where the PDF can be signed: every unsigned signature field and every
 * text field the kit took for a place, with the marks the task agent made
 * and whether each carries this workspace's token (`signMarkToken`). The
 * policy is `choosePlaces`.
 */
export async function listPlaces(
  sandbox: SignSandbox,
  pdf: Uint8Array,
  markToken: string,
  signal?: AbortSignal
): Promise<
  | { readonly inventory: PlaceInventory; readonly kind: "ok" }
  | { readonly kind: "not_pdf" | "unavailable" | "unreadable" }
> {
  const timeoutMs = 60_000;
  return await inFreshDir(sandbox, signal, timeoutMs, async (dir, bounded) => {
    const input = `${dir}/in.pdf`;
    await sandbox.writeBinaryFile({
      abortSignal: bounded,
      content: pdf,
      path: input,
    });
    const result = await kit(
      sandbox,
      dir,
      ["pdf", "sign-places", input, "--mark-token", markToken],
      bounded,
      timeoutMs
    );
    if (result === "unavailable") return { kind: "unavailable" };
    if (result.exitCode === 2) {
      const code = refusalSchema.safeParse(result.json).data?.code;
      return { kind: code === "not_pdf" ? "not_pdf" : "unreadable" };
    }
    const inventory =
      result.exitCode === 0
        ? inventorySchema.safeParse(result.json).data
        : undefined;
    return inventory === undefined
      ? { kind: "unreadable" }
      : { inventory, kind: "ok" };
  });
}

const stampCodes = [
  "already_signed",
  "bad_signature",
  "encrypted",
  "font_missing",
  "plan_mismatch",
  "signed_by_bro",
  "unreadable",
  "xfa",
] as const;

const stampedSchema = z.object({
  drawn: z.array(z.object({ field: z.string() })),
  ok: z.literal(true),
  sha256: z.string().regex(/^[\da-f]{64}$/u),
});

/** What a signing stamps: its places and the person's signature. */
interface StampPlan {
  readonly dateText: string;
  readonly places: readonly {
    readonly field: string;
    readonly role: "date" | "initials" | "signature";
  }[];
  readonly signature:
    | { readonly kind: "image"; readonly png: Uint8Array }
    | {
        readonly initials: string;
        readonly kind: "typed";
        readonly text: string;
      };
  readonly signingId: string;
}

async function stamp(
  sandbox: SignSandbox,
  pdf: Uint8Array,
  plan: StampPlan,
  signal: AbortSignal | undefined,
  timeoutMs: number
): Promise<
  | { readonly kind: "ok"; readonly pdf: Uint8Array; readonly sha256: string }
  | {
      readonly kind: "failed" | "unavailable" | (typeof stampCodes)[number];
    }
> {
  return await inFreshDir(sandbox, signal, timeoutMs, async (dir, bounded) => {
    const input = `${dir}/in.pdf`;
    const output = `${dir}/out.pdf`;
    const planPath = `${dir}/plan.json`;
    // The PNG of an image signature, the font of a typed one.
    const signatureFile =
      plan.signature.kind === "image"
        ? { content: plan.signature.png, path: `${dir}/sig.png` }
        : { content: dataUrlBytes(handFontDataUrl), path: `${dir}/hand.ttf` };
    const signature =
      plan.signature.kind === "image"
        ? { kind: "image", png: signatureFile.path }
        : {
            font: signatureFile.path,
            initials: plan.signature.initials,
            kind: "typed",
            text: plan.signature.text,
          };
    await Promise.all([
      sandbox.writeBinaryFile({
        abortSignal: bounded,
        content: pdf,
        path: input,
      }),
      sandbox.writeBinaryFile({ abortSignal: bounded, ...signatureFile }),
      sandbox.writeTextFile({
        abortSignal: bounded,
        content: JSON.stringify({
          date: plan.dateText,
          places: plan.places.map(({ field, role }) => ({ field, role })),
          signature,
          signing_id: plan.signingId,
        }),
        path: planPath,
      }),
    ]);
    const result = await kit(
      sandbox,
      dir,
      ["pdf", "stamp-sign", input, planPath, "-o", output],
      bounded,
      timeoutMs
    );
    if (result === "unavailable") return { kind: "unavailable" };
    if (result.exitCode === 2) {
      const code = refusalSchema.safeParse(result.json).data?.code;
      return {
        kind: stampCodes.find((known) => known === code) ?? "unreadable",
      };
    }
    const stamped =
      result.exitCode === 0
        ? stampedSchema.safeParse(result.json).data
        : undefined;
    if (stamped === undefined) return { kind: "unreadable" };
    const bytes = await sandbox.readBinaryFile({
      abortSignal: bounded,
      path: output,
    });
    const planned = new Set(plan.places.map(({ field }) => field));
    const drawn = new Set(stamped.drawn.map(({ field }) => field));
    if (
      bytes === null ||
      bytes.byteLength > taskFilesShareBytes ||
      !startsPdf(bytes) ||
      sha256(bytes) !== stamped.sha256 ||
      drawn.size !== planned.size ||
      [...planned].some((field) => !drawn.has(field))
    ) {
      return { kind: "failed" };
    }
    return { kind: "ok", pdf: bytes, sha256: stamped.sha256 };
  });
}

/**
 * The signed PDF: the signature (the PNG, or the typed name in the bundled
 * Marck Script) in each signature and initials place and the date in each
 * date place, the places' fields removed, `signed-by-bro <signingId>` in its
 * keywords. The output is checked against the kit's own hash and the plan.
 */
export async function stampDocument(
  sandbox: SignSandbox,
  pdf: Uint8Array,
  plan: StampPlan,
  signal?: AbortSignal
) {
  return await stamp(sandbox, pdf, plan, signal, 120_000);
}

/**
 * How a typed signature will look: the name in the handwriting font on a
 * one-page PDF (`sandbox/signature/typed-preview.pdf`, one place
 * `bro_preview_signature`), through the same `stamp-sign` as a document.
 */
export async function renderTypedPreview(
  sandbox: SignSandbox,
  text: string,
  signal?: AbortSignal
): Promise<
  | { readonly kind: "ok"; readonly pdf: Uint8Array }
  | { readonly kind: "unavailable" }
> {
  const stamped = await stamp(
    sandbox,
    dataUrlBytes(typedPreviewDataUrl),
    {
      dateText: "",
      places: [{ field: "bro_preview_signature", role: "signature" }],
      signature: { initials: typedInitials(text), kind: "typed", text },
      signingId: "preview",
    },
    signal,
    60_000
  );
  return stamped.kind === "ok"
    ? { kind: "ok", pdf: stamped.pdf }
    : { kind: "unavailable" };
}

/** «Смирнова Анна» → «С.А.», «Смирнова» → «С.»: the first two words. */
export function typedInitials(name: string) {
  return name
    .trim()
    .split(/\s+/u)
    .slice(0, 2)
    .map((word) => `${(Array.from(word).at(0) ?? "").toLocaleUpperCase()}.`)
    .join("");
}
