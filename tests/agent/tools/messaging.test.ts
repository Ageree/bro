import type { DynamicResolveContext } from "eve/tools";
import { describe, expect, it } from "vitest";
import messaging from "@agent/tools/messaging";

describe("send_message channel notes", () => {
  it.each(["channel:eve", "channel:photon", "channel:telegram"])(
    "never tells the model %s delivers an attachment as a link",
    async (channel) => {
      const sendMessage = await resolveSendMessage(channel);

      expect(sendMessage.description).toContain("uploaded to the conversation");
      expect(sendMessage.description).not.toContain("delivered as a link");
      const output = await sendMessage.toModelOutput?.({
        attachments: [
          { kind: "image", url: "https://media.example/result.jpg" },
        ],
        kind: "message",
        text: "Here it is.",
      });

      expect(output).toEqual({
        type: "text",
        value:
          "The message was submitted to the active channel. Do not repeat it in assistant text.",
      });
    }
  );

  it("still explains that a quoted reply is delivered unquoted", async () => {
    const sendMessage = await resolveSendMessage("channel:telegram");

    const output = await sendMessage.toModelOutput?.({
      kind: "message",
      replyTo: { kind: "current" },
      text: "Here it is.",
    });

    expect(output?.type === "text" ? output.value : "").toContain(
      "Native quoted replies are unavailable on this channel"
    );
  });
});

async function resolveSendMessage(channel: string) {
  const resolveMessagingTools = messaging.events["turn.started"];
  if (!resolveMessagingTools) {
    throw new Error("The messaging tools must resolve on a started turn.");
  }
  const tools = await resolveMessagingTools({}, dynamicContext(channel));
  if (!tools || "execute" in tools || !("send_message" in tools)) {
    throw new Error(`The ${channel} channel must expose send_message.`);
  }
  return tools.send_message;
}

function dynamicContext(channel: string) {
  return {
    channel: { kind: channel, metadata: {} },
    messages: [],
    model: null,
    session: {
      auth: {
        current: {
          attributes: { workspaceId: "personal:workspace" },
          authenticator: "photon-imessage",
          principalId: "user-1",
          principalType: "user",
        },
        initiator: null,
      },
      id: "session-1",
    },
  } satisfies DynamicResolveContext;
}
