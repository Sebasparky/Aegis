/**
 * Browser-check interstitial state machine — pure transition + stuck verdict.
 *
 * The browser frequently passes passive Cloudflare-style interstitials by waiting,
 * so the state machine must:
 *  - report a first sighting as `seen` (NEVER stuck — stuck is cross-snapshot),
 *  - report a persisting interstitial as `stuck`,
 *  - report a cleared interstitial on a usable page as `passed`,
 *  - report `escalated_to_hv` whenever a real challenge fired this snapshot,
 *  - emit only safe coarse buckets for the internal observation count.
 */

import { describe, it, expect } from "vitest";
import {
  evaluateBrowserCheckTransition,
  isBrowserCheckStuck,
  browserCheckObservationBucket,
  type BrowserCheckMarker,
} from "../runtime/browserCheckState.js";

const NOW = 1_000_000_000_000;

function marker(over: Partial<BrowserCheckMarker> = {}): BrowserCheckMarker {
  return {
    domain: "example.com",
    first_seen_at: NOW,
    last_seen_at: NOW,
    observation_count: 1,
    ...over,
  };
}

describe("isBrowserCheckStuck — count + elapsed boundaries", () => {
  it("count 1, fresh → not stuck", () => {
    expect(isBrowserCheckStuck(marker({ observation_count: 1 }), NOW)).toBe(false);
  });
  it("count 2 → stuck", () => {
    expect(isBrowserCheckStuck(marker({ observation_count: 2 }), NOW)).toBe(true);
  });
  it("elapsed just under 12s → not stuck", () => {
    expect(isBrowserCheckStuck(marker({ first_seen_at: NOW - 11_900 }), NOW)).toBe(false);
  });
  it("elapsed just over 12s → stuck", () => {
    expect(isBrowserCheckStuck(marker({ first_seen_at: NOW - 12_100 }), NOW)).toBe(true);
  });
});

describe("browserCheckObservationBucket", () => {
  it("maps to coarse buckets", () => {
    expect(browserCheckObservationBucket(0)).toBe("0");
    expect(browserCheckObservationBucket(1)).toBe("1");
    expect(browserCheckObservationBucket(2)).toBe("2");
    expect(browserCheckObservationBucket(7)).toBe("3+");
    expect(browserCheckObservationBucket(NaN)).toBe("0");
  });
});

describe("evaluateBrowserCheckTransition", () => {
  it("first sighting → seen (records, never stuck)", () => {
    const t = evaluateBrowserCheckTransition({
      hvEscalated: false,
      phraseSeen: true,
      pageBlocked: true,
      richUsable: false,
      prior: undefined,
      now: NOW,
    });
    expect(t.outcome).toBe("seen");
    expect(t.seen).toBe(true);
    expect(t.stuck_for_route).toBe(false);
    expect(t.record).toBe(true);
    expect(t.clear).toBe(false);
    expect(t.observation_count_bucket).toBe("1");
  });

  it("persists with a prior count≥1 → stuck (drives route)", () => {
    const t = evaluateBrowserCheckTransition({
      hvEscalated: false,
      phraseSeen: true,
      pageBlocked: true,
      richUsable: false,
      prior: marker({ observation_count: 1, first_seen_at: NOW - 13_000 }),
      now: NOW,
    });
    expect(t.outcome).toBe("stuck");
    expect(t.stuck_for_route).toBe(true);
    expect(t.record).toBe(true);
    expect(t.clear).toBe(false);
    expect(t.observation_count_bucket).toBe("2");
  });

  it("persists but prior not yet stuck (count 1, fresh) → seen", () => {
    const t = evaluateBrowserCheckTransition({
      hvEscalated: false,
      phraseSeen: true,
      pageBlocked: true,
      richUsable: false,
      prior: marker({ observation_count: 1, first_seen_at: NOW }),
      now: NOW,
    });
    expect(t.outcome).toBe("seen");
    expect(t.stuck_for_route).toBe(false);
  });

  it("phrase gone + page now usable → passed (clears)", () => {
    const t = evaluateBrowserCheckTransition({
      hvEscalated: false,
      phraseSeen: false,
      pageBlocked: false,
      richUsable: true,
      prior: marker({ observation_count: 2 }),
      now: NOW,
    });
    expect(t.outcome).toBe("passed");
    expect(t.seen).toBe(true);
    expect(t.record).toBe(false);
    expect(t.clear).toBe(true);
  });

  it("escalation: a real challenge fired → escalated_to_hv regardless of phrase (clears)", () => {
    const t = evaluateBrowserCheckTransition({
      hvEscalated: true,
      phraseSeen: true,
      pageBlocked: true,
      richUsable: false,
      prior: marker({ observation_count: 1 }),
      now: NOW,
    });
    expect(t.outcome).toBe("escalated_to_hv");
    expect(t.seen).toBe(true);
    expect(t.stuck_for_route).toBe(false);
    expect(t.clear).toBe(true);
    expect(t.record).toBe(false);
  });

  it("escalation with no prior + no phrase → none (HV unrelated to browser-check)", () => {
    const t = evaluateBrowserCheckTransition({
      hvEscalated: true,
      phraseSeen: false,
      pageBlocked: true,
      richUsable: false,
      prior: undefined,
      now: NOW,
    });
    expect(t.outcome).toBe("none");
    expect(t.seen).toBe(false);
    expect(t.clear).toBe(false);
  });

  it("no prior + no phrase → none", () => {
    const t = evaluateBrowserCheckTransition({
      hvEscalated: false,
      phraseSeen: false,
      pageBlocked: false,
      richUsable: true,
      prior: undefined,
      now: NOW,
    });
    expect(t.outcome).toBe("none");
    expect(t.seen).toBe(false);
  });

  it("dead band: phrase gone but page still blocked & not usable → holds as none (no premature passed)", () => {
    const t = evaluateBrowserCheckTransition({
      hvEscalated: false,
      phraseSeen: false,
      pageBlocked: true,
      richUsable: false,
      prior: marker({ observation_count: 2 }),
      now: NOW,
    });
    expect(t.outcome).toBe("none");
    expect(t.clear).toBe(false);
  });
});
