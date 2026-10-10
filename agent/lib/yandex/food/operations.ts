import { edaCartOperation, lavkaCartOperation } from "./cart";
import { edaMenuOperation } from "./menu";
import { lavkaAddressesOperation } from "./addresses";
import {
  edaOrdersOperation,
  lavkaActiveOperation,
  lavkaOrdersOperation,
} from "./orders";
import { edaSearchOperation, lavkaSearchOperation } from "./search";

/** Yandex Eda and Lavka's operations, listed for the registry. */
export const foodOperations = [
  edaOrdersOperation,
  lavkaOrdersOperation,
  lavkaActiveOperation,
  lavkaAddressesOperation,
  edaSearchOperation,
  lavkaSearchOperation,
  edaMenuOperation,
  edaCartOperation,
  lavkaCartOperation,
] as const;
