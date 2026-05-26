import { describe, it, expect } from "vitest";
import { compileRoute } from "../services/routeCompiler.js";
import type { RecordingPayload, SemanticRecordingEvent } from "@aegis/types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function clickEvent(label: string, url = "https://en.wikipedia.org/"): SemanticRecordingEvent {
  return {
    type: "click",
    url,
    timestamp: new Date().toISOString(),
    locators: [{ type: "role", role: "button", name: label }],
    element_type: "button",
    element_role: "button",
    visible_text: label,
  };
}

function searchFillEvent(value: string, url = "https://en.wikipedia.org/"): SemanticRecordingEvent {
  return {
    type: "fill",
    url,
    timestamp: new Date().toISOString(),
    locators: [{ type: "placeholder", value: "Search Wikipedia" }],
    element_type: "input",
    element_role: "textbox",
    input_type: "search",
    placeholder: "Search Wikipedia",
    label_text: "Search Wikipedia",
    raw_value: value,
  };
}

function emailFillEvent(value: string, url = "https://example.com/"): SemanticRecordingEvent {
  return {
    type: "fill",
    url,
    timestamp: new Date().toISOString(),
    locators: [{ type: "label", name: "Email" }],
    element_type: "input",
    element_role: "textbox",
    input_type: "email",
    label_text: "Email",
    raw_value: value,
  };
}

function submitEvent(url = "https://en.wikipedia.org/"): SemanticRecordingEvent {
  return {
    type: "submit",
    url,
    timestamp: new Date().toISOString(),
    locators: [{ type: "placeholder", value: "Search Wikipedia" }],
    element_type: "input",
    element_role: "textbox",
    input_type: "search",
    placeholder: "Search Wikipedia",
  };
}

function payload(events: SemanticRecordingEvent[]): RecordingPayload {
  return {
    workflow_name: "Test Workflow",
    domain: "en.wikipedia.org",
    events,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("route compiler – search route normalization", () => {
  it("click search opener + fill search → [fill, submit] (Rule 1 drop + Rule 2 add)", () => {
    const route = compileRoute(payload([
      clickEvent("Search"),
      searchFillEvent("Michigan"),
    ]));

    expect(route.steps).toHaveLength(2);
    expect(route.steps[0].action).toBe("fill");
    expect(route.steps[0].order).toBe(1);
    expect(route.steps[1].action).toBe("submit");
    expect(route.steps[1].order).toBe(2);
    // Inferred submit targets same locator as the fill
    expect(route.steps[1].target.preferred_locator).toEqual(
      route.steps[0].target.preferred_locator
    );
  });

  it("fill search alone (no submit captured) → [fill, submit] (Rule 2 add)", () => {
    const route = compileRoute(payload([
      searchFillEvent("Michigan"),
    ]));

    expect(route.steps).toHaveLength(2);
    expect(route.steps[0].action).toBe("fill");
    expect(route.steps[1].action).toBe("submit");
  });

  it("fill search + click submit → [fill, click] unchanged (Rule 2 skipped)", () => {
    const route = compileRoute(payload([
      searchFillEvent("Michigan"),
      clickEvent("Search"),
    ]));

    expect(route.steps).toHaveLength(2);
    expect(route.steps[0].action).toBe("fill");
    expect(route.steps[1].action).toBe("click");
  });

  it("non-search fill alone does not infer submit (Rule 2 gate)", () => {
    const route = compileRoute(payload([
      emailFillEvent("user@example.com"),
    ]));

    expect(route.steps).toHaveLength(1);
    expect(route.steps[0].action).toBe("fill");
  });

  it("click opener + fill search + click submit is preserved unchanged (Rule 1 gate)", () => {
    // noSubmitAfter is false because click_submit follows → click opener NOT dropped
    const route = compileRoute(payload([
      clickEvent("Search"),
      searchFillEvent("Michigan"),
      clickEvent("Search"),
    ]));

    expect(route.steps).toHaveLength(3);
    expect(route.steps[0].action).toBe("click");
    expect(route.steps[1].action).toBe("fill");
    expect(route.steps[2].action).toBe("click");
  });

  it("step orders are renumbered correctly after normalization", () => {
    const route = compileRoute(payload([
      clickEvent("Search"),
      searchFillEvent("Michigan"),
    ]));

    // After normalization: [fill (order 1), submit (order 2)]
    expect(route.steps[0].order).toBe(1);
    expect(route.steps[1].order).toBe(2);
  });

  it("explicit submit event from recorder → [fill, submit] with no duplication", () => {
    // When the recorder emits both fill and submit (from the new submit handler),
    // the compiler should produce exactly [fill, submit] — Rule 2 must not add another.
    const route = compileRoute(payload([
      searchFillEvent("Michigan"),
      submitEvent(),
    ]));

    expect(route.steps).toHaveLength(2);
    expect(route.steps[0].action).toBe("fill");
    expect(route.steps[1].action).toBe("submit");
  });
});
