import type { ApprovalPolicy } from "eve/tools/approval";
import { always } from "eve/tools/approval";

const approveEveryCall = always();

/**
 * Lets the named read operations of a connection run freely and puts every
 * other call, including any the provider adds later, behind the same
 * per-call approval `always()` gives authored tools. The policy sees the
 * qualified `<connection>__<operation>` name.
 */
export function approveAllButReads(reads: readonly string[]): ApprovalPolicy {
  const readable = new Set(reads);
  return (context) => {
    const separator = context.toolName.indexOf("__");
    const operation =
      separator === -1
        ? context.toolName
        : context.toolName.slice(separator + 2);
    return readable.has(operation)
      ? "not-applicable"
      : approveEveryCall(context);
  };
}
