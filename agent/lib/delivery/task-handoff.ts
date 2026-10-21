import type { ModelMessage } from "ai";
import { browserAnswer } from "./browser-report";
import { currentTurnMessages, sendReachedPerson } from "./turn-sends";

/**
 * What the current turn made of handing work to the task agent (`task`),
 * which works in the background and reports in a turn of its own. Its call
 * answers only `working`: no file, no finding. 21.10 the model read that as
 * the result and wrote a second message with one anyway — «Пятёрочка на
 * Мичуринском, 56… собрал два файла» for a receipt photo, «Family.jpg,
 * report.docx» for a zip that held two text files — none of it seen by
 * anyone. `atWork`: a call answered `working` in this turn. `told`: a message
 * reached the person in a step after it, so they know the work was taken and
 * the turn has nothing more to say until the report comes. A heads-up sent
 * in the call's own step is no such message: the step after it is still free
 * for the rest of what the person asked.
 */
export function taskHandoff(messages: readonly ModelMessage[]) {
  let atWork = false;
  let told = false;
  let calledAt = -1;
  for (const [at, message] of currentTurnMessages(messages).entries()) {
    if (message.role !== "tool") continue;
    const parts = message.content.filter((part) => part.type === "tool-result");
    if (
      atWork &&
      at > calledAt &&
      parts.some(
        (part) =>
          part.toolName === "send_message" && sendReachedPerson(part.output)
      )
    ) {
      told = true;
    }
    if (
      parts.some(
        (part) =>
          part.toolName === "task" &&
          browserAnswer(part.output)?.status === "working"
      )
    ) {
      atWork = true;
      // Another call is another piece of work to tell.
      told = false;
      calledAt = at;
    }
  }
  return { atWork, told };
}

/**
 * What the model reads at every step of a turn that handed work to the task
 * agent, until the turn ends: the call's answer is not the work's result.
 */
export const taskAtWorkNote =
  "The task agent you called in this turn is still working: you have no result, no file and nothing it found, and its report comes later in a message of its own. Do not describe, summarize or promise what it makes or finds, and do not name files, numbers, addresses, names or contents: you have not seen them, so anything of that kind you write now is invented. If the person has not been told yet that you took the work, tell them in one short line that you took it and will send the result, then end the turn. If they have been told, write nothing more and end the turn.";
