import {
  marketCartAddOperation,
  marketCartOperation,
  marketCartRemoveOperation,
} from "./cart";
import { marketOrderOperation, marketOrdersOperation } from "./orders";
import { marketProductOperation } from "./product";
import { marketSearchOperation } from "./search";

/** Yandex Market's operations, as the registry lists them. */
export const marketOperations = [
  marketSearchOperation,
  marketProductOperation,
  marketCartOperation,
  marketCartAddOperation,
  marketCartRemoveOperation,
  marketOrdersOperation,
  marketOrderOperation,
] as const;
