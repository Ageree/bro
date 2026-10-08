import { alertOwner } from "@agent/lib/owner-alert";
import { listPhoneOperatorRequired } from "@db/services/phone";

const repeatAfterMs = 24 * 60 * 60_000;

/**
 * A dedicated number that needs the operator (a purchase that may have been
 * charged but cannot be verified, a release that did not complete) is told to
 * the owner, once a day until it is resolved: nothing retries it by itself.
 * `db` cannot reach the owner alert, so the schedule calls this.
 */
export async function alertPhoneOperator() {
  for (const row of await listPhoneOperatorRequired())
    try {
      await alertOwner(
        `phone-operator-required:${row.id}`,
        `Телефония: номер ${row.number} требует проверки оператора (этап ${row.stage}). Покупка или освобождение не подтверждены провайдером, автоматических повторов нет, плата может продолжаться. Сверьте номер в кабинете Exolve.`,
        { repeatAfterMs }
      );
    } catch {
      // A failed alert must not stop call reconciliation and reports.
      console.warn("[phone] operator alert could not be sent");
    }
}
