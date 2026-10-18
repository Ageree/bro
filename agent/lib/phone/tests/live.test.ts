import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  alawToLinear,
  linearToAlaw,
  linearToUlaw,
  transcode,
  ulawToLinear,
} from "@agent/lib/phone/live/g711";
import { rtpPacket, rtpPayload } from "@agent/lib/phone/live/rtp";
import { sdpAnswer } from "@agent/lib/phone/live/sdp";
import { createServer, type Socket } from "node:net";
import {
  digest,
  header,
  openSip,
  render,
  status,
  takeMessages,
} from "@agent/lib/phone/live/sip";
import { liveCallResult } from "@agent/lib/phone/live/place";
import { spokenPhone } from "@shared/phone/persona";

describe("G.711", () => {
  it("decodes every code back to itself", () => {
    const codes = Array.from({ length: 256 }, (_, byte) => byte);
    expect(codes.map((byte) => linearToAlaw(alawToLinear(byte)))).toEqual(
      codes
    );
    // μ-law has two zeros (0x7f, 0xff): both decode to 0, which encodes as 0xff.
    expect(codes.map((byte) => linearToUlaw(ulawToLinear(byte)))).toEqual(
      codes.map((byte) => (byte === 0x7f ? 0xff : byte))
    );
  });

  it("carries a μ-law leg into A-law within one quantisation step", () => {
    const ulaw = Uint8Array.from([0x00, 0x1f, 0x80, 0xc3, 0xfe]);
    const alaw = transcode(ulaw, "pcmu", "pcma");
    ulaw.forEach((code, index) => {
      const want = ulawToLinear(code);
      const byte = alaw.at(index) ?? 0;
      expect(Math.abs(alawToLinear(byte) - want)).toBeLessThanOrEqual(
        Math.max(16, Math.abs(want) / 16)
      );
    });
  });
});

describe("RTP", () => {
  it("reads the payload past CSRCs, the extension and padding", () => {
    const payload = Uint8Array.from({ length: 160 }, (_, index) => index);
    const plain = rtpPacket({
      payloadType: 8,
      sequence: 1,
      timestamp: 160,
      ssrc: 7,
      payload,
    });
    expect(rtpPayload(plain)).toEqual({
      payloadType: 8,
      payload: Buffer.from(payload),
    });

    const extended = Buffer.concat([
      Buffer.from([0xb1, 0x08, 0, 1, 0, 0, 0, 160, 0, 0, 0, 7]),
      Buffer.from([0, 0, 0, 9]),
      Buffer.from([0xbe, 0xde, 0, 1, 1, 2, 3, 4]),
      Buffer.from(payload),
      Buffer.from([0, 0, 3]),
    ]);
    expect(rtpPayload(extended)?.payload).toEqual(Buffer.from(payload));
    expect(rtpPayload(Buffer.from([0x40, 0, 0]))).toBeNull();
  });
});

describe("SDP", () => {
  it("takes the media-level address and the first G.711 format of the answer", () => {
    const answer = [
      "v=0",
      "o=- 1 1 IN IP4 10.0.0.1",
      "c=IN IP4 10.0.0.1",
      "t=0 0",
      "m=audio 31234 RTP/AVP 0 8 101",
      "c=IN IP4 80.75.130.50",
      "a=rtpmap:0 PCMU/8000",
    ].join("\r\n");
    expect(sdpAnswer(answer)).toEqual({
      address: "80.75.130.50",
      port: 31_234,
      payloadType: 0,
      law: "pcmu",
    });
    expect(
      sdpAnswer("v=0\r\nc=IN IP4 1.2.3.4\r\nm=audio 4000 RTP/AVP 18\r\n")
    ).toBeNull();
  });
});

describe("SIP", () => {
  it("splits a TCP stream into whole messages and keeps a partial one", () => {
    const first =
      "SIP/2.0 100 Trying\r\nv: SIP/2.0/TCP 1.2.3.4;branch=z9hG4bKa\r\nl: 0\r\n\r\n";
    const second = "SIP/2.0 200 OK\r\nContent-Length: 4\r\n\r\nv=0\n";
    const { messages, rest } = takeMessages(
      Buffer.from(`\r\n${first}${second}SIP/2.0 18`)
    );
    expect(messages.map((message) => message.startLine)).toEqual([
      "SIP/2.0 100 Trying",
      "SIP/2.0 200 OK",
    ]);
    const [trying, ok] = messages;
    expect(trying && header(trying, "Via")).toBe(
      "SIP/2.0/TCP 1.2.3.4;branch=z9hG4bKa"
    );
    expect(ok?.body).toBe("v=0\n");
    expect(rest.toString()).toBe("SIP/2.0 18");
  });

  it("answers a digest challenge as RFC 2617 does", () => {
    const value = digest({
      challenge:
        'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"',
      method: "GET",
      uri: "/dir/index.html",
      username: "Mufasa",
      password: "Circle Of Life",
      cnonce: "0a4f113b",
      nc: "00000001",
    });
    expect(value).toContain('response="6629fae49393a05397450978507c4ef1"');
    expect(value).toContain('opaque="5ccc069c403ebaf9f0171e9517f40e41"');
  });
});

describe("a live call's spoken number", () => {
  it("dictates the number by its groups, zeros digit by digit", () => {
    expect(spokenPhone("+79249098921")).toBe(
      "плюс семь, девятьсот двадцать четыре, девятьсот девять, восемьдесят девять, двадцать один"
    );
    expect(spokenPhone("+74950071510")).toBe(
      "плюс семь, четыреста девяносто пять, ноль ноль семь, пятнадцать, десять"
    );
  });
});

describe("a live call's result", () => {
  const outcome = {
    answered: false,
    sipStatus: 486,
    ending: "not_connected" as const,
    talkSeconds: 0,
    transcript: "",
    usageSeconds: 30,
  };

  it("names why a call did not connect and claims nothing was done", () => {
    expect(liveCallResult(outcome)).toMatchObject({
      state: "failed",
      outcome: "busy",
      taskSucceeded: false,
      costUsd: "0.0250",
    });
    expect(liveCallResult({ ...outcome, sipStatus: 487 }).outcome).toBe(
      "no_answer"
    );
    expect(liveCallResult({ ...outcome, sipStatus: null }).outcome).toBe(
      "not_connected"
    );
  });

  it("hands the report a long conversation's start and its end", () => {
    const transcript = Array.from(
      { length: 400 },
      (_, index) => `Собеседник: реплика ${String(index)}`
    ).join("\n");
    const result = liveCallResult({
      ...outcome,
      answered: true,
      sipStatus: 200,
      ending: "hung_up",
      talkSeconds: 61.2,
      transcript,
    });
    expect(result).toMatchObject({
      state: "done",
      taskSucceeded: null,
      durationSeconds: 62,
    });
    expect(result.summary).toContain("реплика 0\n");
    expect(result.summary).toContain("реплика 399");
    expect(result.summary.length).toBeLessThan(6000);
  });
});

/** A carrier that answers a CANCEL first, then the INVITE it cancelled, as real ones do. */
async function carrier(onInvite: (socket: Socket) => void) {
  const server = createServer((socket) => {
    let buffer: Buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      const taken = takeMessages(Buffer.concat([buffer, chunk]));
      buffer = taken.rest;
      for (const message of taken.messages) {
        const method = message.startLine.split(" ")[0];
        const copied = ["via", "from", "to", "call-id", "cseq"].map(
          (name): [string, string] => [name, header(message, name) ?? ""]
        );
        if (method === "INVITE") onInvite(socket);
        if (method === "CANCEL") {
          socket.write(render("SIP/2.0 200 OK", copied));
          const cseq = (header(message, "cseq") ?? "").replace(
            "CANCEL",
            "INVITE"
          );
          socket.write(
            render("SIP/2.0 487 Request Terminated", [
              ...copied.filter(([name]) => name !== "cseq"),
              ["cseq", cseq],
            ])
          );
        }
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    server,
    port: z.object({ port: z.number() }).parse(server.address()).port,
  };
}

const request = (method: string, branch: string) =>
  render(`${method} sip:79990000000@127.0.0.1 SIP/2.0`, [
    ["Via", `SIP/2.0/TCP 127.0.0.1:5060;branch=${branch}`],
    ["From", "<sip:bro@127.0.0.1>;tag=a"],
    ["To", "<sip:79990000000@127.0.0.1>"],
    ["Call-ID", "call@bro"],
    ["CSeq", `1 ${method}`],
  ]);

describe("the SIP connection", () => {
  it("does not take the CANCEL's own 200 for the cancelled call's answer", async () => {
    const { server, port } = await carrier(() => undefined);
    const sip = await openSip({
      host: "127.0.0.1",
      port,
      log: () => undefined,
      onRequest: () => undefined,
    });
    const answer = sip.request(request("INVITE", "z9hG4bKone"), "z9hG4bKone");
    sip.send(request("CANCEL", "z9hG4bKone"));
    expect(status(await answer)).toBe(487);
    sip.close();
    server.close();
  });

  it("gives up waiting for an answer when the connection closes", async () => {
    const { server, port } = await carrier((socket) => {
      socket.destroy();
    });
    const sip = await openSip({
      host: "127.0.0.1",
      port,
      log: () => undefined,
      onRequest: () => undefined,
    });
    await expect(
      sip.request(request("INVITE", "z9hG4bKtwo"), "z9hG4bKtwo")
    ).rejects.toThrow(/closed/u);
    server.close();
  });
});
