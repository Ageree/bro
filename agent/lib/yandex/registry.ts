import type { YandexOperation } from "./operations";
import { statusOperation } from "./status";

/**
 * Every operation the Yandex tool has. A service joins by one line here:
 * its operations are listed beside `statusOperation`, and the tool, its
 * schema and the transport take them from this list.
 */
export const yandexOperations: readonly [
  YandexOperation,
  ...(readonly YandexOperation[]),
] = [statusOperation];

export function findYandexOperation(id: string) {
  return yandexOperations.find((operation) => operation.id === id);
}
