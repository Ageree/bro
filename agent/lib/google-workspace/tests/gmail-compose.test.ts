import { describe, expect, it } from "vitest";
import {
  composeGmailMessage,
  encodeHeaderValue,
  gmailComposeSchema,
  replySubject,
} from "@agent/lib/google-workspace/gmail";

const messageId = "<openinstinct-1@local>";

describe("Gmail message composition", () => {
  it("writes a new email with no threading headers", () => {
    const message = composeGmailMessage(
      compose({ subject: "Status", to: ["person@example.com"] }),
      { messageId }
    );

    expect(headersOf(message)).toEqual([
      "To: person@example.com",
      "Subject: Status",
      `Message-ID: ${messageId}`,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
    ]);
  });

  it("threads a reply under the answered message and extends its chain", () => {
    const message = composeGmailMessage(
      compose({
        cc: ["assistant@example.com"],
        replyToMessageId: "gmail-1",
        subject: "Something else",
        to: ["admissions@ranepa.ru"],
      }),
      {
        messageId,
        replyTo: {
          inReplyTo: "<first@ranepa.ru>",
          messageId: "<second@ranepa.ru>",
          references: "<first@ranepa.ru>",
          subject: "Interview",
          threadId: "thread-1",
        },
      }
    );

    expect(headersOf(message)).toEqual([
      "To: admissions@ranepa.ru",
      "Cc: assistant@example.com",
      "Subject: Re: Interview",
      `Message-ID: ${messageId}`,
      "In-Reply-To: <second@ranepa.ru>",
      "References: <first@ranepa.ru>\r\n <second@ranepa.ru>",
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
    ]);
  });

  it("falls back to In-Reply-To and caps a long References chain", () => {
    const ancestors = Array.from(
      { length: 25 },
      (_, index) => `<m${String(index)}@example.com>`
    );
    const longChain = composeGmailMessage(compose({ replyToMessageId: "g" }), {
      messageId,
      replyTo: {
        inReplyTo: null,
        messageId: "<last@example.com>",
        references: ancestors.join(" "),
        subject: "Re: Plan",
        threadId: "thread-1",
      },
    });
    const references = referencesOf(longChain);
    expect(references).toHaveLength(20);
    expect(references.at(-1)).toBe("<last@example.com>");
    expect(references[0]).toBe("<m6@example.com>");

    const withoutReferences = composeGmailMessage(
      compose({ replyToMessageId: "g" }),
      {
        messageId,
        replyTo: {
          inReplyTo: "<parent@example.com>",
          messageId: "<child@example.com>",
          references: null,
          subject: "Plan",
          threadId: "thread-1",
        },
      }
    );
    expect(referencesOf(withoutReferences)).toEqual([
      "<parent@example.com>",
      "<child@example.com>",
    ]);
  });

  it("still joins the thread when the answered message has no Message-ID", () => {
    const message = composeGmailMessage(compose({ replyToMessageId: "g" }), {
      messageId,
      replyTo: {
        inReplyTo: null,
        messageId: null,
        references: null,
        subject: "Plan",
        threadId: "thread-1",
      },
    });

    expect(headersOf(message)).toContain("Subject: Re: Plan");
    expect(message).not.toContain("In-Reply-To");
    expect(message).not.toContain("References");
  });

  it("does not stack Re: prefixes", () => {
    expect(replySubject("Re: Plan")).toBe("Re: Plan");
    expect(replySubject("RE: Plan")).toBe("RE: Plan");
    expect(replySubject("Plan")).toBe("Re: Plan");
    expect(replySubject("")).toBe("Re:");
  });

  it("encodes a Cyrillic subject as RFC 2047 words without splitting a letter", () => {
    const subject = "Собеседование в РАНХиГС: два варианта времени на неделе";
    const encoded = encodeHeaderValue(subject);
    const words = encoded.split("\r\n ");

    expect(words.length).toBeGreaterThan(1);
    for (const word of words) {
      expect(word).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/u);
      expect(word.length).toBeLessThanOrEqual(75);
    }
    expect(
      words
        .map((word) =>
          Buffer.from(word.slice(10, -2), "base64").toString("utf8")
        )
        .join("")
    ).toBe(subject);
    expect(encodeHeaderValue("Plain")).toBe("Plain");
  });

  it("keeps header injection out of the headers", () => {
    const message = composeGmailMessage(
      compose({ subject: "Hi\r\nBcc: attacker@example.com" }),
      { messageId }
    );

    expect(headersOf(message)).not.toContain("Bcc: attacker@example.com");
    expect(headersOf(message)).toContain(
      "Subject: Hi Bcc: attacker@example.com"
    );
  });

  it("carries the body as wrapped base64 UTF-8", () => {
    const body = "Добрый день! ".repeat(20);
    const message = composeGmailMessage(compose({ body, subject: "S" }), {
      messageId,
    });
    const encoded = message.slice(message.indexOf("\r\n\r\n") + 4);

    for (const line of encoded.split("\r\n")) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
    expect(
      Buffer.from(encoded.replaceAll("\r\n", ""), "base64").toString()
    ).toBe(body);
  });

  it("requires a subject for a new email but not for a reply", () => {
    const base = { body: "Hello", to: ["person@example.com"] };

    expect(gmailComposeSchema.safeParse(base).success).toBe(false);
    expect(
      gmailComposeSchema.safeParse({ ...base, subject: "Hello" }).success
    ).toBe(true);
    expect(
      gmailComposeSchema.safeParse({ ...base, replyToMessageId: "gmail-1" })
        .success
    ).toBe(true);
  });
});

function compose(
  input: Partial<Parameters<typeof composeGmailMessage>[0]>
): Parameters<typeof composeGmailMessage>[0] {
  return {
    bcc: [],
    body: "Hello",
    cc: [],
    to: ["person@example.com"],
    ...input,
  };
}

function headersOf(message: string) {
  const head = message.slice(0, message.indexOf("\r\n\r\n"));
  return head.split(/\r\n(?! )/u);
}

function referencesOf(message: string) {
  const line = headersOf(message).find((value) =>
    value.startsWith("References: ")
  );
  return line?.slice("References: ".length).split("\r\n ") ?? [];
}
