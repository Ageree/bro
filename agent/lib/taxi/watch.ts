import type { AttachSessionFn } from "eve/channels";
import { sendCodeNotice } from "@agent/lib/delivery/code-notice";
import { goWatchOperation } from "@agent/lib/yandex/go/watch";
import { runYandexOperation } from "@agent/lib/yandex/transport";
import {
  claimDueTaxiWatches,
  claimTaxiNotice,
  finishTaxiWatch,
  noteTaxiWatch,
  releaseTaxiNotice,
  type TaxiNotice,
} from "@db/services/taxi-watches";

/** The person is told to step out when the car is this close. */
const leaveWithinSeconds = 130;
/** Within this, the ride is read again inside the tick, not a minute later. */
const closingInSeconds = 300;
const rereadMs = 20_000;
const rereadsPerTick = 3;
/** Longer than the tick's own reads, so the next tick does not read it too. */
const leaseMs = 100_000;
const idleRetryMs = 60_000;

interface Delivery {
  readonly attachSession?: AttachSessionFn;
}
type Watch = Awaited<ReturnType<typeof claimDueTaxiWatches>>[number];
type Ride = Extract<
  ReturnType<typeof goWatchOperation.result.parse>,
  { kind: "ride" }
>;

const minutes = (seconds: number) => Math.max(1, Math.round(seconds / 60));

/**
 * The words of each notice, code's own: the person reads where the car is
 * from Yandex's answer, never from a model's guess. The car is named by what
 * Yandex gives; the time only when Yandex gave it.
 */
function taxiNoticeText(
  notice: TaxiNotice,
  ride: Pick<Ride, "car" | "etaSeconds">
) {
  const car = ride.car === null ? "Машина" : `Машина (${ride.car})`;
  if (notice === "arrived") return `${car} на месте. Выходи.`;
  if (notice === "leave") {
    return ride.etaSeconds !== null && ride.etaSeconds >= 75
      ? `Пора выходить: ${car} будет на месте через ~${String(minutes(ride.etaSeconds))} мин.`
      : `Пора выходить: ${car} вот-вот подъедет.`;
  }
  const found =
    ride.car === null ? "Нашёл машину" : `Нашёл машину: ${ride.car}`;
  return ride.etaSeconds === null
    ? `${found}. Напишу, когда она подъедет.`
    : `${found}, будет через ~${String(minutes(ride.etaSeconds))} мин. Напишу, когда пора выходить.`;
}

/**
 * Reads each booked ride that is being watched and tells the person, in the
 * chat they booked it in, that a car is found, that it is time to step out
 * (the car is about two minutes away) and that it is at the door, without the
 * model. A ride Yandex no longer lists, a car the person is already in, or
 * one booked for someone else after the first notice, ends its watch.
 */
export async function watchTaxiRides(delivery: Delivery, now: Date) {
  const watches = await claimDueTaxiWatches(now, leaseMs);
  await Promise.all(watches.map((watch) => watchOne(delivery, watch)));
}

async function watchOne(delivery: Delivery, watch: Watch) {
  try {
    await followRide(delivery, watch);
  } catch (error) {
    console.warn("[taxi] watch failed", {
      name: error instanceof Error ? error.name : "unknown",
    });
  }
}

/* oxlint-disable eslint/no-await-in-loop -- a ride's reads follow one another: each answer decides the next read. */
async function followRide(delivery: Delivery, watch: Watch) {
  let seenStatus = watch.status;
  for (let read = 0; ; read += 1) {
    const outcome = await runYandexOperation(
      watch.workspaceId,
      goWatchOperation,
      { orderId: watch.orderId }
    );
    if (outcome.kind === "signed_out") return finishTaxiWatch(watch.id);
    if (outcome.kind !== "ok") {
      return noteTaxiWatch(
        watch.id,
        { car: watch.car, status: seenStatus },
        new Date(Date.now() + idleRetryMs)
      );
    }
    const answer = goWatchOperation.result.parse(outcome.data);
    if (answer.kind === "gone") return finishTaxiWatch(watch.id);
    if (answer.status === "driving" && seenStatus !== "driving") {
      // Where Yandex keeps the time to the car was not seen on a live ride:
      // when it is missing, the names it answered with say where to look.
      console.info("[taxi] car found", {
        fields: answer.etaSeconds === null ? answer.fields : undefined,
        timeKnown: answer.etaSeconds !== null,
      });
    }
    seenStatus = answer.status;
    const done = await tellRide(delivery, watch, answer);
    if (done) return finishTaxiWatch(watch.id);
    await noteTaxiWatch(
      watch.id,
      { car: answer.car ?? watch.car, status: answer.status },
      new Date(Date.now() + idleRetryMs)
    );
    const closing =
      answer.etaSeconds !== null &&
      answer.etaSeconds > leaveWithinSeconds &&
      answer.etaSeconds <= closingInSeconds;
    if (!closing || read >= rereadsPerTick) return;
    await new Promise((resolve) => setTimeout(resolve, rereadMs));
  }
}

/* oxlint-enable eslint/no-await-in-loop */

/** Tells what the ride's state asks to be told; true when the watch is over. */
async function tellRide(delivery: Delivery, watch: Watch, ride: Ride) {
  if (ride.status === "transporting" || ride.status === "complete") {
    return true;
  }
  if (ride.status === "waiting") {
    if (!watch.forPassenger) await tell(delivery, watch, "arrived", ride);
    return true;
  }
  if (ride.status !== "driving") return false;
  const close =
    ride.etaSeconds !== null && ride.etaSeconds <= leaveWithinSeconds;
  if (watch.forPassenger) {
    await tell(delivery, watch, "found", ride);
    return true;
  }
  if (close) {
    // Found and close in one read: the one notice that matters.
    await claimTaxiNotice(watch.id, "found", new Date());
    await tell(delivery, watch, "leave", ride);
    return false;
  }
  await tell(delivery, watch, "found", ride);
  return false;
}

async function tell(
  delivery: Delivery,
  watch: Watch,
  notice: TaxiNotice,
  ride: Pick<Ride, "car" | "etaSeconds">
) {
  if (!(await claimTaxiNotice(watch.id, notice, new Date()))) return;
  try {
    await sendCodeNotice(
      delivery,
      {
        about: { taxiWatchId: watch.id },
        conversationChannel: watch.conversationChannel,
        conversationId: watch.conversationId,
        userId: watch.userId,
        workspaceId: watch.workspaceId,
      },
      taxiNoticeText(notice, ride)
    );
    console.info("[taxi] told", { notice });
  } catch (error) {
    console.warn("[taxi] notice failed", {
      cause: error,
      channel: watch.conversationChannel,
      notice,
    });
    await releaseTaxiNotice(watch.id, notice);
  }
}
