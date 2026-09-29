/**
 * A Browser Use Cloud reply that was not a 2xx, with enough of the body to
 * act on. The browser VM backend (`agent/lib/browser-vm/runs.ts`) answers
 * with the same error, so the queue, the retries and the tool act on a VM
 * errand exactly as on a Browser Use one: a 429 waits in the queue, a 409 is
 * a busy session, a 404 a session or run that is gone. It lives apart from
 * `client.ts` because the client dispatches to the VM backend, which could
 * not import it back.
 */
export class BrowserUseError extends Error {
  readonly status: number;
  /** How long Browser Use asked the caller to wait, when it said. */
  readonly retryAfterMs: number | undefined;

  constructor(
    status: number,
    path: string,
    body: string,
    retryAfterMs?: number
  ) {
    super(`Browser Use ${String(status)} on ${path}: ${body.slice(0, 300)}`);
    this.name = "BrowserUseError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}
