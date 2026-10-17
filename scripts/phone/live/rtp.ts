import { createSocket } from "node:dgram";
import { randomInt } from "node:crypto";

// RFC 3550 framing for one G.711 leg: 20 ms frames, 160 samples at 8 kHz.
export const frameBytes = 160;
export const frameMs = 20;

export function rtpPacket(input: {
  payloadType: number;
  sequence: number;
  timestamp: number;
  ssrc: number;
  payload: Uint8Array;
}) {
  const packet = Buffer.alloc(12 + input.payload.length);
  packet[0] = 0x80;
  packet[1] = input.payloadType & 0x7f;
  packet.writeUInt16BE(input.sequence & 0xffff, 2);
  packet.writeUInt32BE(input.timestamp >>> 0, 4);
  packet.writeUInt32BE(input.ssrc >>> 0, 8);
  packet.set(input.payload, 12);
  return packet;
}

/** The payload of an RTP packet, past CSRCs, the extension and padding; null for what is not RTP v2. */
export function rtpPayload(packet: Uint8Array) {
  if (packet.length < 12) return null;
  const view = Buffer.from(packet.buffer, packet.byteOffset, packet.length);
  const first = view.readUInt8(0);
  if (first >> 6 !== 2) return null;
  let start = 12 + (first & 0x0f) * 4;
  if (first & 0x10) {
    if (view.length < start + 4) return null;
    start += 4 + view.readUInt16BE(start + 2) * 4;
  }
  const padding = first & 0x20 ? view.readUInt8(view.length - 1) : 0;
  const end = view.length - padding;
  if (start > end) return null;
  return {
    payloadType: view.readUInt8(1) & 0x7f,
    payload: view.subarray(start, end),
  };
}

/**
 * One UDP port for the call's audio. Sending starts the moment the far side is known: the first packets
 * open the VM's stateful firewall for the carrier's reply, so a frame of silence goes out every 20 ms
 * even while nothing is said.
 */
export async function openRtp(options: {
  onFrame: (payload: Uint8Array, payloadType: number) => void;
  nextFrame: () => Uint8Array;
}) {
  const socket = createSocket("udp4");
  socket.on("message", (message) => {
    const parsed = rtpPayload(message);
    if (parsed) options.onFrame(parsed.payload, parsed.payloadType);
  });
  const port = await bind(socket);
  socket.on("error", (error) => {
    console.warn(`RTP socket: ${error.message}`);
  });
  let timer: NodeJS.Timeout | undefined;
  let far = { address: "", port: 0, payloadType: 8 };
  return {
    port,
    /** Starts sending, or points it at a newer answer (a 200 after an early-media 183). */
    start(remote: { address: string; port: number; payloadType: number }) {
      far = remote;
      if (timer) return;
      const ssrc = randomInt(2 ** 31);
      let sequence = randomInt(2 ** 15);
      let timestamp = randomInt(2 ** 31);
      const began = performance.now();
      let sent = 0;
      // Drift-corrected: each frame goes at began + n·20 ms, not 20 ms after the last one.
      const tick = () => {
        while (performance.now() - began >= sent * frameMs) {
          socket.send(
            rtpPacket({
              payloadType: far.payloadType,
              sequence,
              timestamp,
              ssrc,
              payload: options.nextFrame(),
            }),
            far.port,
            far.address
          );
          sequence += 1;
          timestamp += frameBytes;
          sent += 1;
        }
        timer = setTimeout(
          tick,
          Math.max(1, began + sent * frameMs - performance.now())
        );
      };
      tick();
    },
    close() {
      clearTimeout(timer);
      socket.close();
    },
  };
}

// An even port in the dynamic range, as RTP expects; a taken one is tried again.
async function bind(socket: ReturnType<typeof createSocket>) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = 20_000 + randomInt(5000) * 2;
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Ports are tried one at a time.
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.bind(port, () => {
          socket.off("error", reject);
          resolve();
        });
      });
      return port;
    } catch {
      // The port is taken: the next try picks another.
    }
  }
  throw new Error("No free UDP port for the call's audio.");
}
