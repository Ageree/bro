import { afishaPricesOperation } from "./afisha/prices";
import { afishaSearchOperation } from "./afisha/search";
import { afishaTicketsOperation } from "./afisha/tickets";
import { foodOperations } from "./food/operations";
import type { YandexOperation } from "./operations";
import { goRideOperation } from "./go/booking";
import { goEstimateOperation } from "./go/estimate";
import { goRidesOperation } from "./go/rides";
import { marketOperations } from "./market";
import { mapsOrgOperation } from "./maps/org";
import { mapsSearchOperation } from "./maps/search";
import { accountReadyOperation } from "./ready";
import { statusOperation } from "./status";

/**
 * Every operation the Yandex tool has. A service joins by one line here:
 * its operations are listed beside `statusOperation`, and the tool, its
 * schema and the transport take them from this list.
 */
export const yandexOperations: readonly [
  YandexOperation,
  ...(readonly YandexOperation[]),
] = [
  statusOperation,
  accountReadyOperation,
  goEstimateOperation,
  goRidesOperation,
  goRideOperation,
  mapsSearchOperation,
  mapsOrgOperation,
  afishaSearchOperation,
  afishaPricesOperation,
  afishaTicketsOperation,
  ...marketOperations,
  ...foodOperations,
];

export function findYandexOperation(id: string) {
  return yandexOperations.find((operation) => operation.id === id);
}
