import type { Page, Locator } from "playwright";

export interface ElementTarget {
  type: "text" | "selector";
  value: string;
}

export interface ElementInfo {
  found: boolean;
  tagName: string;
  text: string;
  inputType?: string;
  id?: string;
  name?: string;
  autocomplete?: string;
  placeholder?: string;
}

function resolveLocator(page: Page, target: ElementTarget, forClick = true): Locator {
  if (target.type === "selector") {
    return page.locator(target.value).first();
  }
  // Text-based: for clicks prefer button/link roles, fall back to any text match
  if (forClick) {
    return page
      .getByRole("button", { name: target.value, exact: false })
      .or(page.getByRole("link", { name: target.value, exact: false }))
      .or(page.getByText(target.value, { exact: false }))
      .first();
  }
  // Text-based for type: find by label or placeholder
  return page
    .getByLabel(target.value, { exact: false })
    .or(page.getByPlaceholder(target.value, { exact: false }))
    .first();
}

export async function getElementInfo(
  page: Page,
  target: ElementTarget,
  forClick = true
): Promise<ElementInfo> {
  const locator = resolveLocator(page, target, forClick);

  let count = 0;
  try {
    count = await locator.count();
  } catch {
    return { found: false, tagName: "", text: "" };
  }

  if (count === 0) {
    return { found: false, tagName: "", text: "" };
  }

  try {
    // Callback runs in browser context — cast to any to avoid requiring dom lib.
    const info = await locator.evaluate((el: any) => ({
      tagName: el.tagName.toLowerCase(),
      text: (el.innerText ?? el.textContent ?? "").trim(),
      inputType: el.type || undefined,
      id: el.id || undefined,
      name: el.name || undefined,
      autocomplete: el.autocomplete || undefined,
      placeholder: el.placeholder || undefined,
    }));
    return { found: true, ...info };
  } catch {
    return { found: false, tagName: "", text: "" };
  }
}

export async function performClick(page: Page, target: ElementTarget): Promise<void> {
  const locator = resolveLocator(page, target, true);
  await locator.click({ timeout: 5_000 });
}

export async function performType(
  page: Page,
  target: ElementTarget,
  value: string
): Promise<void> {
  const locator = resolveLocator(page, target, false);
  await locator.fill(value, { timeout: 5_000 });
}
