import { describe, expect, it, vi } from "vitest";
import type { env } from "@shared/environment";

// The one setting the switch reads, writable for each case.
interface Switch {
  EVE_SCHEDULES: (typeof env)["EVE_SCHEDULES"];
}

const environment: Switch = vi.hoisted(() => ({ EVE_SCHEDULES: "on" }));

vi.mock("@shared/environment", () => ({ env: environment }));

import {
  browserRunsEnabled,
  schedulesEnabled,
} from "@agent/lib/schedules/enabled";

describe("EVE_SCHEDULES", () => {
  it.each([
    ["on", true, true],
    ["off", false, false],
    // A stand carries its own errands through the pool, and nothing else of
    // production's copy runs: no mail checks, reminders or calls.
    ["browser", false, true],
  ] as const)("%s: schedules %s, browser errands %s", (value, all, browser) => {
    environment.EVE_SCHEDULES = value;
    expect(schedulesEnabled()).toBe(all);
    expect(browserRunsEnabled()).toBe(browser);
  });
});
