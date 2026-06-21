/**
 * Browser-check interstitial phrase matcher — passive-only + disjoint from HV.
 *
 * BROWSER_CHECK_PHRASE_RE recognizes passive Cloudflare-style "Checking your
 * browser" / "Just a moment" interstitials ONLY. It must NEVER match active-
 * challenge phrasing — those stay owned by HV_TEXT_RE / the page-level HV wall
 * path so such pages route as human-verification (escalated), never as a passive
 * browser-check. This test pins both the positive matches and the disjointness.
 */

import { describe, it, expect } from "vitest";
import { matchesBrowserCheckPhrase } from "../runtime/antigenSnapshotRuntime.js";

describe("matchesBrowserCheckPhrase — passive interstitial phrases", () => {
  const PASSIVE_PHRASES = [
    "Checking your browser before accessing the site.",
    "Just a moment...",
    "Please wait while we verify your connection.",
    "Please wait while we check your browser.",
    "Enable JavaScript and cookies to continue.",
    "DDoS protection by Cloudflare",
    "This process is automatic. Your browser will redirect shortly.",
    "Your browser will redirect to your requested content shortly.",
  ];

  it.each(PASSIVE_PHRASES)("matches passive phrase: %s", (phrase) => {
    expect(matchesBrowserCheckPhrase(phrase)).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(matchesBrowserCheckPhrase("CHECKING YOUR BROWSER")).toBe(true);
  });
});

describe("matchesBrowserCheckPhrase — disjoint from active-challenge phrasing", () => {
  // These belong to HV_TEXT_RE / page_level_hv_wall and must NOT be claimed by
  // the passive browser-check matcher (otherwise a real challenge would be
  // mislabeled as a benign interstitial).
  const ACTIVE_CHALLENGE_PHRASES = [
    "Verify you are human",
    "Verifying you are human",
    "Confirm that you are a human",
    "Prove you are human",
    "Complete the CAPTCHA to continue",
    "captcha",
    "Press & Hold to confirm",
    "Press and hold the button",
    "Please complete this security challenge",
    "challenge",
    "I'm not a robot",
    "robot check",
    "Security check",
    "Access to this page has been denied",
  ];

  it.each(ACTIVE_CHALLENGE_PHRASES)("does NOT match active-challenge phrase: %s", (phrase) => {
    expect(matchesBrowserCheckPhrase(phrase)).toBe(false);
  });

  it("does not match ordinary product-page copy", () => {
    expect(matchesBrowserCheckPhrase("Add to bag — Free shipping over $50")).toBe(false);
    expect(matchesBrowserCheckPhrase("Sign in to your account")).toBe(false);
  });
});
