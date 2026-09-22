import { z } from "zod";
import {
  browserVerificationPlanSchema,
  browserVerificationProofSchema,
  browserVerificationReportSchema,
  type BrowserVerificationPlan,
  type BrowserVerificationProof,
  type BrowserVerificationReport,
} from "@shared/browser/verification";
import { findBrowserUseSessionCdpUrl } from "./client";

const defaultDeadlineMs = 3_000;
const maximumConcurrentPages = 4;
const forbiddenScopeSelector = /^(?:\*|:root|html|body)$/iu;
const checksLine =
  /^[ \t]*(?:[-*•]+[ \t]*)?\*{0,2}CHECKS\*{0,2}[ \t]*:\*{0,2}[ \t]*(.*)$/imu;

const targetSchema = z.object({
  type: z.string().optional(),
  url: z.string().optional(),
  webSocketDebuggerUrl: z.string().optional(),
});

const cdpMessageSchema = z.object({
  error: z.object({ code: z.number(), message: z.string() }).optional(),
  id: z.number().int().optional(),
  result: z.json().optional(),
});

const cdpParametersSchema = z.record(z.string(), z.json());

const evaluationSchema = z.object({
  exceptionDetails: z.json().optional(),
  result: z
    .object({
      value: z.json().optional(),
    })
    .optional(),
});

const frameTreeSchema = z.object({
  frameTree: z.object({ frame: z.object({ id: z.string().min(1) }) }),
});

const isolatedWorldSchema = z.object({ executionContextId: z.number().int() });

const domObservationSchema = z.object({
  broadScope: z.boolean(),
  candidateId: z.number().int().nonnegative().nullable(),
  checkId: z.string(),
  matchCount: z.number().int().nonnegative(),
  scopeCount: z.number().int().nonnegative(),
  sensitive: z.boolean(),
  text: z.string(),
  truncated: z.boolean(),
  visible: z.boolean(),
});

const domReadSchema = z.object({
  observations: z.array(domObservationSchema),
  pageUrl: z.string(),
});

const domReadProgram = `function (locators) {
  const queryDocument = (selector) => Document.prototype.querySelectorAll.call(document, selector);
  const queryElement = (element, selector) => Element.prototype.querySelectorAll.call(element, selector);
  const candidateSelector = "[data-offer-id], [data-product-id], [data-item-id], [data-testid*='offer'], [data-testid*='product'], [data-testid*='card'], [role='listitem'], article, li";
  const candidateIds = new WeakMap();
  let nextCandidateId = 1;
  const identity = (element) => {
    if (!element) return null;
    const known = candidateIds.get(element);
    if (known) return known;
    const id = nextCandidateId++;
    candidateIds.set(element, id);
    return id;
  };
  const sensitive = (element) => {
    if (!(element instanceof Element)) return false;
    if (Element.prototype.matches.call(element, "script, style, noscript, template") || queryElement(element, "script, style, noscript, template").length > 0) return true;
    const fields = [element, ...queryElement(element, "input, textarea, select")];
    return fields.some((field) => {
      const input = field instanceof HTMLInputElement ? field : null;
      const bits = [field.getAttribute("name"), field.getAttribute("id"), field.getAttribute("autocomplete"), field.getAttribute("aria-label")].filter(Boolean).join(" ").toLowerCase();
      const identifier = bits.replace(/[^a-z0-9]+/g, "_");
      return input?.type === "password" || /(?:password|passcode|otp|one-time-code|current-password|new-password|cc-|card.?number|cvv|cvc|security.?code)/i.test(bits) || /(?:^|_)(?:token|api_key|apikey|private_key|privatekey|credential|authorization|secret|access_token|refresh_token|session_token)(?:_|$)/i.test(identifier);
    });
  };
  const visible = (element) => {
    if (!(element instanceof HTMLElement) || element.hidden || element.closest("[hidden], [aria-hidden='true']")) return false;
    if (element.getClientRects().length === 0) return false;
    let current = element;
    while (current instanceof HTMLElement) {
      const style = getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0" || style.contentVisibility === "hidden") return false;
      current = current.parentElement;
    }
    return true;
  };
  const miss = (checkId, scopeCount, matchCount, broadScope = false) => ({ checkId, scopeCount, matchCount, broadScope, candidateId: null, sensitive: false, text: "", truncated: false, visible: false });
  const observations = locators.map((locator) => {
    let scopes;
    try { scopes = Array.from(queryDocument(locator.scopeSelector)); }
    catch { return miss(locator.checkId, 0, 0); }
    if (scopes.length !== 1) return miss(locator.checkId, scopes.length, 0);
    const scope = scopes[0];
    const broadScope = scope === document.documentElement || scope === document.body;
    if (broadScope) return miss(locator.checkId, 1, 0, true);
    let matches;
    try { matches = Array.from(queryElement(scope, locator.selector)); }
    catch { return miss(locator.checkId, 1, 0); }
    if (matches.length !== 1) return miss(locator.checkId, 1, matches.length);
    const element = matches[0];
    const blocked = sensitive(element);
    if (blocked) return { ...miss(locator.checkId, 1, 1), sensitive: true };
    const rendered = visible(element);
    if (!rendered) return miss(locator.checkId, 1, 1);
    const scopeIsCandidate = Element.prototype.matches.call(scope, candidateSelector);
    const structural = Array.from(queryElement(scope, candidateSelector));
    if (scopeIsCandidate) structural.unshift(scope);
    const nearest = Element.prototype.closest.call(element, candidateSelector);
    const candidate = nearest && scope.contains(nearest) ? nearest : scopeIsCandidate ? scope : null;
    const value = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement ? element.value : element instanceof HTMLElement ? element.innerText : element.textContent || "";
    const normalized = String(value).replace(/\\s+/g, " ").trim();
    const truncated = normalized.length > 1000;
    const text = normalized.slice(0, 1000);
    return { checkId: locator.checkId, scopeCount: 1, matchCount: 1, broadScope: false, candidateId: identity(candidate), sensitive: false, text, truncated, visible: true };
  });
  return { observations, pageUrl: String(location.href) };
}`;

interface VerificationInput {
  readonly deadlineMs?: number;
  readonly plan: BrowserVerificationPlan;
  readonly result: string | null | undefined;
  readonly sessionId: string;
}

type Defect = BrowserVerificationReport["defects"][number];
type ObservedCheck = BrowserVerificationReport["observedChecks"][number];
type FreshObservation = z.infer<typeof domObservationSchema> & {
  readonly observedAt: string;
  readonly pageUrl: string;
};

interface CheckEvaluation {
  readonly defects: Defect[];
  readonly observation: ObservedCheck;
}

export async function verifyBrowserRun(
  input: VerificationInput
): Promise<BrowserVerificationReport> {
  const started = performance.now();
  const deadlineMs = Math.min(
    defaultDeadlineMs,
    Math.max(50, Math.floor(input.deadlineMs ?? defaultDeadlineMs))
  );
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, deadlineMs);
  const finish = (
    verdict: BrowserVerificationReport["verdict"],
    observedChecks: ObservedCheck[],
    defects: Defect[]
  ) =>
    browserVerificationReportSchema.parse({
      defects,
      elapsedMs: Math.max(0, Math.round(performance.now() - started)),
      observedChecks,
      verdict,
    });

  try {
    const plan = browserVerificationPlanSchema.safeParse(input.plan);
    if (!plan.success) {
      return finish(
        "unverified",
        [],
        [
          {
            code: "invalid_evidence",
            message: "The acceptance plan is invalid.",
          },
        ]
      );
    }
    const proof = parseProof(input.result);
    if (proof === undefined) {
      return finish(
        "unverified",
        [],
        [
          {
            code: "missing_evidence",
            message: "The browser did not return a CHECKS packet.",
          },
        ]
      );
    }
    if (!proof.success) {
      return finish(
        "unverified",
        [],
        [
          {
            code: "invalid_evidence",
            message: "The browser did not return a valid CHECKS packet.",
          },
        ]
      );
    }
    const packetDefects = validatePacket(plan.data, proof.data);
    if (packetDefects.length > 0)
      return finish("unverified", [], packetDefects);

    controller.signal.throwIfAborted();
    const cdpUrl = await findBrowserUseSessionCdpUrl(
      input.sessionId,
      controller.signal
    );
    controller.signal.throwIfAborted();
    if (!cdpUrl) {
      return finish(
        "unverified",
        [],
        [{ code: "unavailable", message: "The run's browser is unavailable." }]
      );
    }
    const targets = await discoverTargets(cdpUrl, controller.signal);
    controller.signal.throwIfAborted();
    const pageGroups = new Map<string, typeof proof.data.checks>();
    for (const locator of proof.data.checks) {
      const group = pageGroups.get(locator.pageUrl) ?? [];
      group.push(locator);
      pageGroups.set(locator.pageUrl, group);
    }

    const observations = new Map<string, FreshObservation>();
    const pages = [...pageGroups.entries()];
    const replies = await Promise.all(
      pages.map(async ([pageUrl, locators]) => {
        const matches = targets.filter(
          (target) => target.type === "page" && target.url === pageUrl
        );
        if (matches.length !== 1) {
          return {
            defect: {
              code: matches.length === 0 ? "page_missing" : "ambiguous_match",
              message:
                matches.length === 0
                  ? "An evidence page is no longer open."
                  : "More than one open page matches the evidence URL.",
            } satisfies Defect,
          };
        }
        const socketUrl = matches[0]?.webSocketDebuggerUrl;
        if (!socketUrl) {
          return {
            defect: {
              code: "unavailable",
              message: "An evidence page has no debugger endpoint.",
            } satisfies Defect,
          };
        }
        const read = await readPage(
          socketUrl,
          pageUrl,
          locators,
          controller.signal
        );
        if ("defect" in read) return read;
        const observedAt = new Date().toISOString();
        const observedPageUrl = sanitizeObservedUrl(read.pageUrl);
        return {
          observations: read.observations.map((observation) => ({
            broadScope: observation.broadScope,
            candidateId: observation.candidateId,
            checkId: observation.checkId,
            matchCount: observation.matchCount,
            observedAt,
            pageUrl: observedPageUrl,
            scopeCount: observation.scopeCount,
            sensitive: observation.sensitive,
            text: observation.text,
            truncated: observation.truncated,
            visible: observation.visible,
          })),
        };
      })
    );
    const readDefects: Defect[] = [];
    for (const reply of replies) {
      if ("defect" in reply) readDefects.push(reply.defect);
      else {
        for (const observation of reply.observations)
          observations.set(observation.checkId, observation);
      }
    }
    if (readDefects.length > 0) return finish("unverified", [], readDefects);

    const groupDefects = validateObservedGroups(plan.data, observations);
    if (groupDefects.length > 0) return finish("unverified", [], groupDefects);

    const evaluated = plan.data.checks.flatMap((check) => {
      const observation = observations.get(check.id);
      return observation ? [evaluateCheck(check, observation)] : [];
    });
    const defects = evaluated.flatMap((entry) => entry.defects);
    const observedChecks = evaluated.map((entry) => entry.observation);
    const mandatory = new Set(
      plan.data.checks
        .filter((check) => check.mandatory)
        .map((check) => check.id)
    );
    const mandatoryResults = observedChecks.filter((entry) =>
      mandatory.has(entry.checkId)
    );
    const verdict = mandatoryResults.some((entry) => entry.status === "failed")
      ? "failed"
      : mandatoryResults.some((entry) => entry.status === "unverified")
        ? "unverified"
        : "verified";
    return finish(verdict, observedChecks, defects);
  } catch {
    const timedOut = controller.signal.aborted;
    return finish(
      "unverified",
      [],
      [
        {
          code: timedOut ? "timeout" : "unavailable",
          message: timedOut
            ? "Browser verification exceeded its deadline."
            : "Browser verification could not read the open page.",
        },
      ]
    );
  } finally {
    clearTimeout(timer);
  }
}

function parseProof(result: string | null | undefined) {
  const text = result ?? "";
  const match = checksLine.exec(text);
  if (!match) return undefined;
  const json = [match[1] ?? "", text.slice(match.index + match[0].length)]
    .filter(Boolean)
    .join("\n")
    .trim();
  try {
    return browserVerificationProofSchema.safeParse(JSON.parse(json));
  } catch {
    return browserVerificationProofSchema.safeParse(undefined);
  }
}

function validatePacket(
  plan: BrowserVerificationPlan,
  proof: BrowserVerificationProof
) {
  const defects: Defect[] = [];
  if (
    new Set(proof.checks.map(({ pageUrl }) => pageUrl)).size >
    maximumConcurrentPages
  ) {
    defects.push({
      code: "invalid_evidence",
      message: "Evidence can reference at most four open pages.",
    });
  }
  const planned = new Map(plan.checks.map((check) => [check.id, check]));
  const evidence = new Map<string, (typeof proof.checks)[number]>();
  for (const locator of proof.checks) {
    if (evidence.has(locator.checkId)) {
      defects.push({
        checkId: locator.checkId,
        code: "duplicate_evidence",
        message: "A check has more than one evidence locator.",
      });
    }
    if (!planned.has(locator.checkId)) {
      defects.push({
        checkId: locator.checkId,
        code: "invalid_evidence",
        message: "Evidence refers to an unknown check.",
      });
    }
    if (forbiddenScopeSelector.test(locator.scopeSelector.trim())) {
      defects.push({
        checkId: locator.checkId,
        code: "invalid_evidence",
        message: "Evidence cannot use the whole document as its scope.",
      });
    }
    if (isSensitiveBrowserUrl(locator.pageUrl)) {
      defects.push({
        checkId: locator.checkId,
        code: "invalid_evidence",
        message: "A live browser endpoint cannot be used as page evidence.",
      });
    }
    evidence.set(locator.checkId, locator);
  }
  for (const check of plan.checks) {
    if (!check.mandatory || evidence.has(check.id)) continue;
    defects.push({
      checkId: check.id,
      code: "missing_evidence",
      message: "A mandatory check has no evidence locator.",
    });
  }
  const groups = new Map<string, { pageUrl: string; scopeSelector: string }>();
  for (const check of plan.checks) {
    if (!check.groupId) continue;
    const locator = evidence.get(check.id);
    if (!locator) continue;
    const first = groups.get(check.groupId);
    if (!first) {
      groups.set(check.groupId, locator);
      continue;
    }
    if (
      first.pageUrl !== locator.pageUrl ||
      first.scopeSelector !== locator.scopeSelector
    ) {
      defects.push({
        checkId: check.id,
        code: "group_mismatch",
        message: "Grouped checks do not share the same page and exact scope.",
      });
    }
  }
  return defects;
}

function validateObservedGroups(
  plan: BrowserVerificationPlan,
  observations: ReadonlyMap<string, FreshObservation>
) {
  const defects: Defect[] = [];
  const groups = new Map<string, number>();
  const resolvedCounts = new Map<string, number>();
  for (const check of plan.checks) {
    if (!check.groupId) continue;
    const observation = observations.get(check.id);
    if (observation?.scopeCount === 1 && observation.matchCount === 1)
      resolvedCounts.set(
        check.groupId,
        (resolvedCounts.get(check.groupId) ?? 0) + 1
      );
  }
  for (const check of plan.checks) {
    if (!check.groupId) continue;
    const observation = observations.get(check.id);
    if (
      observation?.scopeCount !== 1 ||
      observation.matchCount !== 1 ||
      (resolvedCounts.get(check.groupId) ?? 0) < 2
    )
      continue;
    const candidateId = observation.candidateId;
    const first = groups.get(check.groupId);
    if (candidateId === null) {
      defects.push({
        checkId: check.id,
        code: "group_mismatch",
        message: "A grouped check is not bound to an exact candidate.",
      });
      continue;
    }
    if (first === undefined) groups.set(check.groupId, candidateId);
    else if (first !== candidateId) {
      defects.push({
        checkId: check.id,
        code: "group_mismatch",
        message: "Grouped checks resolved to different candidates.",
      });
    }
  }
  return defects;
}

async function discoverTargets(cdpUrl: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const base = cdpUrl
    .trim()
    .replace(/\/$/u, "")
    .replace(/^ws:/iu, "http:")
    .replace(/^wss:/iu, "https:");
  const response = await fetch(`${base}/json`, { signal });
  if (!response.ok) throw new Error("Browser target discovery failed.");
  return z.array(targetSchema).parse(await response.json());
}

async function readPage(
  socketUrl: string,
  expectedPageUrl: string,
  locators: BrowserVerificationProof["checks"],
  signal: AbortSignal
): Promise<{ defect: Defect } | z.infer<typeof domReadSchema>> {
  signal.throwIfAborted();
  const socket = new WebSocket(socketUrl);
  try {
    await socketOpen(socket, signal);
    const treeReply = await cdpCall(socket, "Page.getFrameTree", {}, signal);
    if (treeReply.error) return javascriptDefect();
    const tree = frameTreeSchema.safeParse(treeReply.result);
    if (!tree.success) return javascriptDefect();
    const worldReply = await cdpCall(
      socket,
      "Page.createIsolatedWorld",
      {
        frameId: tree.data.frameTree.frame.id,
        worldName: "browser-verification-read",
      },
      signal
    );
    if (worldReply.error) return javascriptDefect();
    const world = isolatedWorldSchema.safeParse(worldReply.result);
    if (!world.success) return javascriptDefect();
    const expression = `(${domReadProgram})(${JSON.stringify(locators)})`;
    const reply = await cdpCall(
      socket,
      "Runtime.evaluate",
      {
        awaitPromise: false,
        contextId: world.data.executionContextId,
        expression,
        returnByValue: true,
      },
      signal
    );
    if (reply.error) {
      return {
        defect: {
          code: "javascript_error",
          message: "The browser rejected the fixed DOM read.",
        },
      };
    }
    const evaluation = evaluationSchema.safeParse(reply.result);
    if (!evaluation.success || evaluation.data.exceptionDetails) {
      return {
        defect: {
          code: "javascript_error",
          message: "The fixed DOM read failed in the page.",
        },
      };
    }
    const parsed = domReadSchema.safeParse(evaluation.data.result?.value);
    if (!parsed.success) {
      return {
        defect: {
          code: "javascript_error",
          message: "The page returned malformed DOM evidence.",
        },
      };
    }
    if (parsed.data.pageUrl !== expectedPageUrl) {
      return {
        defect: {
          code: "page_missing",
          message: "The evidence page navigated before it could be verified.",
        },
      };
    }
    const expectedIds = locators.map(({ checkId }) => checkId).toSorted();
    const actualIds = parsed.data.observations
      .map(({ checkId }) => checkId)
      .toSorted();
    if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
      return {
        defect: {
          code: "javascript_error",
          message: "The page returned incomplete DOM evidence.",
        },
      };
    }
    return parsed.data;
  } finally {
    socket.close();
  }
}

function javascriptDefect() {
  return {
    defect: {
      code: "javascript_error" as const,
      message: "The fixed DOM read could not enter an isolated page world.",
    },
  };
}

function socketOpen(socket: WebSocket, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      signal.removeEventListener("abort", abort);
      socket.removeEventListener("open", open);
      socket.removeEventListener("error", error);
    };
    const abort = () => {
      cleanup();
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("Browser verification was aborted.")
      );
    };
    const open = () => {
      cleanup();
      resolve();
    };
    const error = () => {
      cleanup();
      reject(new Error("Debugger connection failed."));
    };
    signal.addEventListener("abort", abort, { once: true });
    socket.addEventListener("open", open, { once: true });
    socket.addEventListener("error", error, { once: true });
    if (signal.aborted) abort();
  });
}

function cdpCall(
  socket: WebSocket,
  method: string,
  params: z.infer<typeof cdpParametersSchema>,
  signal: AbortSignal
) {
  signal.throwIfAborted();
  return new Promise<z.infer<typeof cdpMessageSchema>>((resolve, reject) => {
    const id = 1;
    const cleanup = () => {
      signal.removeEventListener("abort", abort);
      socket.removeEventListener("message", message);
    };
    const abort = () => {
      cleanup();
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("Browser verification was aborted.")
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    const message = (event: MessageEvent) => {
      const parsed = cdpMessageSchema.safeParse(safeJson(String(event.data)));
      if (!parsed.success || parsed.data.id !== id) return;
      cleanup();
      resolve(parsed.data);
    };
    socket.addEventListener("message", message);
    if (signal.aborted) {
      abort();
      return;
    }
    socket.send(JSON.stringify({ id, method, params }));
  });
}

function evaluateCheck(
  check: BrowserVerificationPlan["checks"][number],
  evidence: FreshObservation
): CheckEvaluation {
  if (evidence.broadScope) {
    return unverified(
      check.id,
      "The evidence resolved to the whole document.",
      evidence,
      "invalid_evidence"
    );
  }
  if (
    evidence.scopeCount === 0 ||
    (evidence.scopeCount === 1 && evidence.matchCount === 0)
  ) {
    return unverified(
      check.id,
      "The evidence locator did not resolve to an element.",
      evidence,
      "missing_evidence"
    );
  }
  if (evidence.scopeCount !== 1 || evidence.matchCount > 1) {
    return unverified(
      check.id,
      "The evidence locator did not resolve to one exact element.",
      evidence,
      "ambiguous_match"
    );
  }
  if (evidence.sensitive) {
    return unverified(
      check.id,
      "Sensitive form inputs cannot be verification evidence.",
      evidence,
      "sensitive_evidence"
    );
  }
  if (!evidence.visible) {
    return unverified(
      check.id,
      "The evidence element is not visibly rendered.",
      evidence,
      "invalid_evidence"
    );
  }
  if (evidence.truncated) {
    return unverified(
      check.id,
      "The bounded DOM observation was truncated.",
      evidence,
      "invalid_evidence"
    );
  }
  const text = normalizeText(evidence.text);
  const predicate = check.predicate;
  if (predicate.kind === "number") {
    const value = parseNumber(
      text,
      predicate.decimalSeparator,
      predicate.currency
    );
    if (value === undefined) {
      return unverified(
        check.id,
        "The numeric evidence is missing or ambiguous.",
        evidence,
        "invalid_evidence"
      );
    }
    const passed =
      (predicate.minimum === undefined || value >= predicate.minimum) &&
      (predicate.maximum === undefined || value <= predicate.maximum);
    return {
      defects: passed
        ? []
        : [
            {
              checkId: check.id,
              code: "acceptance_failed",
              message: "The observed number is outside the accepted bounds.",
            },
          ],
      observation: {
        checkId: check.id,
        observedAt: evidence.observedAt,
        pageUrl: evidence.pageUrl,
        status: passed ? "passed" : "failed",
        value,
      },
    };
  }
  const actual = predicate.caseSensitive ? text : text.toLocaleLowerCase();
  const expected = predicate.caseSensitive
    ? normalizeText(predicate.expected)
    : normalizeText(predicate.expected).toLocaleLowerCase();
  const passed =
    predicate.kind === "text_exact"
      ? actual === expected
      : predicate.kind === "text_contains"
        ? actual.includes(expected)
        : !actual.includes(expected);
  return {
    defects: passed
      ? []
      : [
          {
            checkId: check.id,
            code: "acceptance_failed",
            message: "The observed text does not satisfy the acceptance check.",
          },
        ],
    observation: {
      checkId: check.id,
      observation: sanitizeObservation(text),
      observedAt: evidence.observedAt,
      pageUrl: evidence.pageUrl,
      status: passed ? "passed" : "failed",
    },
  };
}

function unverified(
  checkId: string,
  message: string,
  evidence: FreshObservation,
  code: Defect["code"] = "missing_evidence"
) {
  return {
    defects: [{ checkId, code, message }],
    observation: {
      checkId,
      observedAt: evidence.observedAt,
      pageUrl: evidence.pageUrl,
      status: "unverified" as const,
    },
  };
}

function parseNumber(
  text: string,
  decimalSeparator: "." | ",",
  currency: "EUR" | "GBP" | "RUB" | "USD" | undefined
) {
  const currencyPattern = {
    EUR: /(?:€|\bEUR\b)/iu,
    GBP: /(?:£|\bGBP\b)/iu,
    RUB: /(?:₽|\bRUB\b|\bруб\.?)/iu,
    USD: /(?:\$|\bUSD\b)/iu,
  } as const;
  if (currency && !currencyPattern[currency].test(text)) return undefined;
  const candidates = text.match(/[+-]?\d(?:[\d \u00a0.,]*\d)?/gu) ?? [];
  if (candidates.length !== 1) return undefined;
  const raw = candidates[0].replaceAll(/[ \u00a0]/gu, "");
  const thousandsSeparator = decimalSeparator === "." ? "," : ".";
  const parts = raw.split(decimalSeparator);
  if (parts.length > 2) return undefined;
  const [integer = "", fraction] = parts;
  const signless = integer.replace(/^[+-]/u, "");
  const groups = signless.split(thousandsSeparator);
  if (
    groups.length > 1 &&
    (groups[0]?.length === 0 ||
      groups.slice(1).some((part) => part.length !== 3))
  )
    return undefined;
  if (fraction !== undefined && !/^\d{1,2}$/u.test(fraction)) return undefined;
  const normalized = `${integer.replaceAll(thousandsSeparator, "")}${fraction === undefined ? "" : `.${fraction}`}`;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : undefined;
}

function normalizeText(value: string) {
  return value.replaceAll(/\s+/gu, " ").trim();
}

function sanitizeObservation(value: string) {
  return value
    .replaceAll(/https?:\/\/\S+/giu, "[URL]")
    .replaceAll(
      /\b(?:password|passcode|otp|one[- ]time code|token)[ \t]*[:=]?[ \t]*\S+/giu,
      "[redacted]"
    )
    .replaceAll(/\p{Cc}/gu, "")
    .slice(0, 240);
}

function sanitizeObservedUrl(value: string) {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.hash = "";
  const sensitiveQuery = [...url.searchParams.keys()].some((key) => {
    const normalized = key.replaceAll(/[^a-z0-9]/giu, "").toLowerCase();
    return (
      normalized === "key" ||
      normalized === "code" ||
      /(?:token|authorization|credential|signature|secret|password|session|apikey|accesskey|privatekey|secretkey|signed)/u.test(
        normalized
      )
    );
  });
  if (sensitiveQuery) url.search = "";
  return url.toString();
}

function isSensitiveBrowserUrl(value: string) {
  const { hostname } = new URL(value);
  return /^(?:live[.-]|.*browser-use)/iu.test(hostname);
}

function safeJson(value: string) {
  try {
    return z.json().parse(JSON.parse(value));
  } catch {
    return undefined;
  }
}
