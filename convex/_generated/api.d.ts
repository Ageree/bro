/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as access from "../access.js";
import type * as billing from "../billing.js";
import type * as browserFollow from "../browserFollow.js";
import type * as browsers from "../browsers.js";
import type * as cabinet from "../cabinet.js";
import type * as crons from "../crons.js";
import type * as http from "../http.js";
import type * as jobs from "../jobs.js";
import type * as lib_accessPolicy from "../lib/accessPolicy.js";
import type * as lib_billingPolicy from "../lib/billingPolicy.js";
import type * as lib_browserFollowPolicy from "../lib/browserFollowPolicy.js";
import type * as lib_browseruse from "../lib/browseruse.js";
import type * as lib_cabinetPolicy from "../lib/cabinetPolicy.js";
import type * as lib_dedicatedLinePolicy from "../lib/dedicatedLinePolicy.js";
import type * as lib_mailPolicy from "../lib/mailPolicy.js";
import type * as lib_memoryPolicy from "../lib/memoryPolicy.js";
import type * as lib_rateLimits from "../lib/rateLimits.js";
import type * as lib_vaultPayload from "../lib/vaultPayload.js";
import type * as lib_wakeupCrons from "../lib/wakeupCrons.js";
import type * as lib_wakeupPolicy from "../lib/wakeupPolicy.js";
import type * as memories from "../memories.js";
import type * as orders from "../orders.js";
import type * as secret from "../secret.js";
import type * as tenants from "../tenants.js";
import type * as vault from "../vault.js";
import type * as vaultSecrets from "../vaultSecrets.js";
import type * as wakeups from "../wakeups.js";
import type * as workflow from "../workflow.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  access: typeof access;
  billing: typeof billing;
  browserFollow: typeof browserFollow;
  browsers: typeof browsers;
  cabinet: typeof cabinet;
  crons: typeof crons;
  http: typeof http;
  jobs: typeof jobs;
  "lib/accessPolicy": typeof lib_accessPolicy;
  "lib/billingPolicy": typeof lib_billingPolicy;
  "lib/browserFollowPolicy": typeof lib_browserFollowPolicy;
  "lib/browseruse": typeof lib_browseruse;
  "lib/cabinetPolicy": typeof lib_cabinetPolicy;
  "lib/dedicatedLinePolicy": typeof lib_dedicatedLinePolicy;
  "lib/mailPolicy": typeof lib_mailPolicy;
  "lib/memoryPolicy": typeof lib_memoryPolicy;
  "lib/rateLimits": typeof lib_rateLimits;
  "lib/vaultPayload": typeof lib_vaultPayload;
  "lib/wakeupCrons": typeof lib_wakeupCrons;
  "lib/wakeupPolicy": typeof lib_wakeupPolicy;
  memories: typeof memories;
  orders: typeof orders;
  secret: typeof secret;
  tenants: typeof tenants;
  vault: typeof vault;
  vaultSecrets: typeof vaultSecrets;
  wakeups: typeof wakeups;
  workflow: typeof workflow;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  crons: import("@convex-dev/crons/_generated/component.js").ComponentApi<"crons">;
  rateLimiter: import("@convex-dev/rate-limiter/_generated/component.js").ComponentApi<"rateLimiter">;
  workflow: import("@convex-dev/workflow/_generated/component.js").ComponentApi<"workflow">;
};
