import type { Page, BrowserContext } from "playwright";
import {
  type ElementTarget,
  type ElementInfo,
  getElementInfo,
  performClick,
  performType,
} from "./actionInspector.js";
import type { CheckoutData } from "../services/mockVaultService.js";

export class SessionController {
  constructor(
    private readonly page: Page,
    private readonly context: BrowserContext
  ) {}

  async navigate(url: string): Promise<{ title: string; url: string }> {
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    return { title: await this.page.title(), url: this.page.url() };
  }

  async readPage(): Promise<{ title: string; url: string; text_preview: string }> {
    const title = await this.page.title();
    const url = this.page.url();
    // Runs in browser context; cast through globalThis to avoid requiring dom lib.
    const raw = await this.page.evaluate(() => (globalThis as any).document?.body?.innerText ?? "");
    return { title, url, text_preview: raw.slice(0, 2000).trim() };
  }

  async screenshot(): Promise<string> {
    const buf = await this.page.screenshot({ type: "png" });
    return buf.toString("base64");
  }

  async getElementInfo(target: ElementTarget, forClick = true): Promise<ElementInfo> {
    return getElementInfo(this.page, target, forClick);
  }

  async click(target: ElementTarget): Promise<void> {
    await performClick(this.page, target);
  }

  async type(target: ElementTarget, value: string): Promise<void> {
    await performType(this.page, target, value);
  }

  /**
   * Fills the mock checkout form using fake vault data.
   * Each field is attempted independently — a missing field does not abort the rest.
   * Returns the names of fields that were successfully filled.
   * Never logs raw card numbers, CVV, or sensitive values.
   */
  async fillCheckoutFromVault(data: CheckoutData): Promise<{ fields_filled: string[] }> {
    const filled: string[] = [];

    const tryFill = async (name: string, selector: string, value: string) => {
      try {
        await this.page.fill(selector, value);
        filled.push(name);
      } catch {
        // field absent or not interactable — skip silently
      }
    };

    const trySelect = async (name: string, selector: string, value: string) => {
      try {
        await this.page.selectOption(selector, value);
        filled.push(name);
      } catch {
        // select absent or value not found — skip silently
      }
    };

    await tryFill("email", "#email", data.email);
    await tryFill("phone", "#phone", data.phone);
    await tryFill("street_address", "#address", data.streetAddress);
    await tryFill("city", "#city", data.city);
    await tryFill("zip", "#zip", data.zip);
    await trySelect("country", "#country", data.countryValue);
    await tryFill("card_number", "#cc-number", data.cardNumber);
    await tryFill("card_expiry", "#cc-exp", data.cardExpiry);
    await tryFill("card_cvv", "#cc-csc", data.cardCvv);
    await tryFill("name_on_card", "#cc-name", data.nameOnCard);

    return { fields_filled: filled };
  }

  async close(): Promise<void> {
    await this.context.close();
  }
}
