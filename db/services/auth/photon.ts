import {
  createiMessageAdapter,
  type iMessageAdapter,
} from "@photon-ai/chat-adapter-imessage";
import * as z from "zod";
import { photonProjectCredentials } from "@shared/photon/credentials";

// Photon has no REST send endpoint: outbound iMessage goes through the same
// adapter the channel uses, which resolves project credentials lazily and
// opens the 1:1 conversation before posting.
let adapter: iMessageAdapter | undefined;

// Photon's adapter and its spectrum transport classify failures by error name
// and carry a provider code; neither type is exported, so match the shape.
const providerErrorSchema = z.object({
  code: z.string().min(1).optional(),
  message: z.string().min(1).optional(),
  name: z.enum([
    "AdapterError",
    "AdapterRateLimitError",
    "AuthenticationError",
    "ConnectionError",
    "IMessageError",
    "NotFoundError",
    "NotImplementedError",
    "RateLimitError",
    "ValidationError",
  ]),
});

export class PhotonDeliveryError extends Error {
  readonly code: string | undefined;
  readonly kind: string;
  readonly photonMessage: string | undefined;

  constructor({
    code,
    kind,
    photonMessage,
  }: {
    readonly code?: string;
    readonly kind: string;
    readonly photonMessage?: string;
  }) {
    const diagnostics = [
      code === undefined ? undefined : `code ${code}`,
      photonMessage,
    ]
      .filter((value) => value !== undefined)
      .join("; ");
    super(
      `Photon message delivery failed with ${kind}${
        diagnostics.length === 0 ? "" : ` (${diagnostics})`
      }.`
    );
    this.name = "PhotonDeliveryError";
    this.code = code;
    this.kind = kind;
    this.photonMessage = photonMessage;
  }
}

export function photonOtpFailure(error: PhotonDeliveryError) {
  switch (error.kind) {
    case "AuthenticationError": {
      return {
        code: "IMESSAGE_PROJECT_NOT_AUTHORIZED",
        message:
          "Не вышло отправить код: вход через iMessage сейчас не работает. Попробуй позже.",
      };
    }
    case "NotFoundError": {
      return {
        code: "IMESSAGE_RECIPIENT_UNKNOWN",
        message:
          "Не вышло написать на этот номер в iMessage. Проверь номер: на нём должен быть включён iMessage.",
      };
    }
    case "ConnectionError": {
      return {
        code: "IMESSAGE_SERVICE_UNAVAILABLE",
        message:
          "iMessage сейчас не отвечает. Подожди немного и запроси код ещё раз.",
      };
    }
    case "AdapterRateLimitError":
    case "RateLimitError": {
      return {
        code: "IMESSAGE_RATE_LIMITED",
        message:
          "Слишком много кодов запрошено с этого номера. Подожди немного и запроси код ещё раз.",
      };
    }
    case "ValidationError": {
      return {
        code: "IMESSAGE_RECIPIENT_UNREACHABLE",
        message:
          "Этот номер не принимает iMessage. Нужен номер с включённым iMessage — например, номер iPhone.",
      };
    }
    default: {
      return {
        code: "IMESSAGE_DELIVERY_FAILED",
        message:
          "Не удалось отправить код в iMessage. Проверь номер и попробуй ещё раз.",
      };
    }
  }
}

export async function sendPhotonText({
  message,
  to,
}: {
  readonly message: string;
  readonly to: string;
}) {
  adapter ??= createiMessageAdapter({ credentials: photonProjectCredentials });
  try {
    const threadId = await adapter.openDM(to);
    await adapter.postMessage(threadId, { raw: message });
  } catch (error) {
    const provider = providerErrorSchema.safeParse(error);
    if (!provider.success) throw error;
    throw new PhotonDeliveryError({
      code: provider.data.code,
      kind: provider.data.name,
      photonMessage: provider.data.message,
    });
  }
}
