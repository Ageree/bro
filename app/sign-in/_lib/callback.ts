/**
 * Where sign-in sends the person back: a path on this site, or the cabinet.
 * «//host» and «/\host» leave the site — browsers read a backslash as a
 * slash — so both go to the cabinet.
 */
export function ownCallbackUrl(requested: string | undefined) {
  return requested?.startsWith("/") &&
    !requested.startsWith("//") &&
    !requested.includes("\\")
    ? requested
    : "/workspace";
}
