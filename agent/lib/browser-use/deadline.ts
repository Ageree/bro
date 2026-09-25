/**
 * What `work` settled with, or `timedOut` once it has taken longer than
 * `ms`. Only the wait is cut short: the work itself goes on, and a rejection
 * that comes after the deadline is still handled rather than left loose.
 *
 * The poller awaits Browser Use, the database and eve for every open run in
 * one `Promise.all`, and Nitro hands a tick that finds the task still running
 * the same promise: one answer that never came used to stop every report
 * after it, without a line in the logs.
 */
export async function within<T>(
  work: Promise<T>,
  ms: number
): Promise<
  { readonly timedOut: false; readonly value: T } | { readonly timedOut: true }
> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ readonly timedOut: true }>((resolve) => {
    timer = setTimeout(() => {
      resolve({ timedOut: true });
    }, ms);
  });
  try {
    return await Promise.race([
      work.then((value) => ({ timedOut: false as const, value })),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
