import { fileURLToPath } from "node:url";
import { defineEval, type EveEvalContext, type EveEvalTurn } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { z } from "zod";
import { agentEvalTags } from "@evals/agent/shared";
import { sendMessageOutputSchema } from "@shared/chat/message-delivery";
import { env } from "@shared/environment";

const tags = [...agentEvalTags, "content"] as const;
/** A CC0 photo of a golden retriever from Wikimedia Commons. */
const dogPhoto = fileURLToPath(new URL("fixtures/dog.jpg", import.meta.url));
const artifactOutputSchema = z.object({ artifact: z.string() });
const imagesInputSchema = z.object({ images: z.array(z.string()) });

/**
 * `generate_image` exists only on a deployment with OpenRouter and private
 * Blob storage, so the picture cases run only against one.
 */
const picturesConfigured =
  env.OPENROUTER_API_KEY !== undefined &&
  (env.BLOB_READ_WRITE_TOKEN ?? env.BLOB_STORE_ID) !== undefined;

const gameCases = [
  defineEval({
    description: "Hosts a trivia game in the chat one question at a time",
    tags,
    async test(t) {
      const turn = await t.send(
        "Давай быструю викторину про фильмы 90-х для нашей компании"
      );
      turn.expectOk();
      turn.succeeded();
      turn.calledTool("send_message");
      t.judge(
        "The assistant starts hosting an interactive trivia game about 1990s movies right in the chat: it asks exactly one question, possibly with answer options, and waits for an answer. It does not list several questions at once, does not reveal the answer, and does not refuse.",
        { on: turn.session.transcript }
      )
        .label("hosted trivia game")
        .atLeast(0.8);
    },
  }),
];

const pictureCases = [
  defineEval({
    description:
      "Draws a birthday picture and starts a trivia game in one request",
    tags,
    async test(t) {
      const turn = await t.send(
        "Make a birthday image for Sam with our dog on it, then a quick trivia game about 90s movies for the group chat."
      );
      turn.expectOk();
      turn.succeeded();
      turn.calledTool("generate_image");
      const artifact = requireArtifact(turn);
      await requirePictureDelivered(t, turn, artifact);
      t.check(
        deliveredCount(turn),
        satisfies<number>(
          (count) => count <= 3,
          "the picture and the first question fit in three messages"
        )
      );
      t.judge(
        "The assistant delivers a birthday picture for Sam and starts hosting a 1990s movie trivia game by asking exactly one question, without listing several questions at once or revealing the answer.",
        { on: turn.session.transcript }
      )
        .label("picture and hosted game")
        .atLeast(0.8);
    },
  }),
  defineEval({
    description: "Edits the birthday picture after a few quiz answers",
    tags,
    async test(t) {
      // EN D16 on 24.09: the picture and the quiz worked, then «English
      // text, Sam's name on the cake» after the quiz answers never happened.
      const first = await t.send(
        "Make a birthday image for Sam with a cake on it, then a quick trivia game about 90s movies for the group chat."
      );
      first.expectOk();
      const artifact = requireArtifact(first);
      let last = first;
      for (const answer of ["B", "C"]) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- The quiz goes one answer at a time.
        last = await last.session.send(answer);
        last.expectOk();
      }

      const edit = await last.session.send(
        "Make the text on the picture English and put Sam's name on the cake"
      );
      edit.expectOk();
      edit.calledTool("generate_image");
      checkEditsPicture(t, edit, artifact);
      await requirePictureDelivered(t, edit, requireArtifact(edit));
    },
  }),
  defineEval({
    description: "Puts the person's own dog on the picture and edits it",
    tags,
    async test(t) {
      const session = await t.session();
      const first = await session.sendFile(
        "Сделай открытку на день рождения Сэма с нашим псом, вот он",
        dogPhoto,
        "image/jpeg"
      );
      first.expectOk();
      first.calledTool("generate_image", { input: { photos: [1] } });
      const artifact = requireArtifact(first);
      await requirePictureDelivered(t, first, artifact);

      const edit = await first.session.send("сделай поярче");
      edit.expectOk();
      edit.calledTool("generate_image");
      checkEditsPicture(t, edit, artifact);
      await requirePictureDelivered(t, edit, requireArtifact(edit));
    },
  }),
];

export default picturesConfigured ? [...gameCases, ...pictureCases] : gameCases;

function requireArtifact(turn: EveEvalTurn) {
  const call = turn.requireToolCall("generate_image", { status: "completed" });
  const parsed = artifactOutputSchema.safeParse(call.output);
  if (!parsed.success) {
    throw new Error("generate_image did not return an artifact.");
  }
  return parsed.data.artifact;
}

/** An edit draws from the earlier picture, not from scratch. */
function checkEditsPicture(
  t: EveEvalContext,
  edit: EveEvalTurn,
  artifact: string
) {
  const editInputs = edit.toolCalls
    .filter((call) => call.name === "generate_image")
    .map((call) => imagesInputSchema.safeParse(call.input));
  t.check(
    editInputs,
    satisfies<typeof editInputs>(
      (inputs) =>
        inputs.some(
          (input) =>
            input.success &&
            input.data.images.some((image) => image.includes(artifact))
        ),
      "the edit passes the earlier picture back as a reference"
    )
  );
}

/** Messages that reached the person; a dropped or returned send did not. */
function deliveredCount(turn: EveEvalTurn) {
  return turn.toolCalls.filter(
    (call) =>
      call.name === "send_message" &&
      call.status === "completed" &&
      sendMessageOutputSchema.safeParse(call.output).success
  ).length;
}

async function requirePictureDelivered(
  t: EveEvalContext,
  turn: EveEvalTurn,
  artifact: string
) {
  const delivered = turn.toolCalls.some(
    (call) =>
      call.name === "send_message" &&
      JSON.stringify(call.input).includes(artifact)
  );
  await t.require(
    delivered,
    satisfies<boolean>(Boolean, "send_message delivers the drawn picture")
  );
}
