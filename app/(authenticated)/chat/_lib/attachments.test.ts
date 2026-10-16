import { ClientError } from "eve/client";
import { describe, expect, it } from "vitest";
import { sendFailure } from "./attachments";

describe("send failures", () => {
  it("keeps a message eve refused and names the file it found too large", () => {
    const outcome = sendFailure(
      new ClientError(
        413,
        JSON.stringify({
          error: "x",
          ok: false,
          violations: [{ filename: "скан.pdf", kind: "too-large" }],
        })
      )
    );

    expect(outcome.keep).toBe(true);
    expect(outcome.text).toContain("скан.pdf");
  });

  it("keeps a message whose POST failed on the server", () => {
    expect(sendFailure(new ClientError(500, "{}")).keep).toBe(true);
  });

  // The connection may have dropped after eve took the message: sending it
  // again would repeat it.
  it("lets go of a message the network lost", () => {
    expect(sendFailure(new TypeError("Failed to fetch")).keep).toBe(false);
  });
});
