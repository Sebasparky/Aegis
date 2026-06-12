/**
 * Payment fill execution ordering — unit tests.
 *
 * OPPWA iframe fills (card_number / cvv) can re-render the host page and stale every
 * top-level ag_* ref the agent still holds for the remaining fields. When several fields
 * are queued under one authorization, parent-page antigen_ref fields must execute FIRST
 * and iframe-capable fields LAST. The helper drives recommended_fill_order in the
 * create/execute responses and the tool guidance; it changes sequencing only — never
 * approval, ref validation, or fail-closed stale-ref behavior.
 */

import { describe, it, expect } from "vitest";
import type { PaymentCardField } from "@aegis/types";
import {
  orderPaymentFillFields,
  isIframeCapablePaymentField,
} from "../runtime/paymentCardFill.js";

describe("isIframeCapablePaymentField", () => {
  it("flags only card_number and cvv as iframe-capable", () => {
    expect(isIframeCapablePaymentField("card_number")).toBe(true);
    expect(isIframeCapablePaymentField("cvv")).toBe(true);
    expect(isIframeCapablePaymentField("expiry_combined")).toBe(false);
    expect(isIframeCapablePaymentField("cardholder_name")).toBe(false);
    expect(isIframeCapablePaymentField("billing_zip")).toBe(false);
  });
});

describe("orderPaymentFillFields", () => {
  it("puts parent-page antigen_ref fields before iframe fields (the IKEA 4-field case)", () => {
    const queued: PaymentCardField[] = ["card_number", "expiry_combined", "cvv", "cardholder_name"];
    expect(orderPaymentFillFields(queued)).toEqual([
      "expiry_combined",
      "cardholder_name",
      "card_number",
      "cvv",
    ]);
  });

  it("keeps card_number before cvv and expiry before cardholder", () => {
    const all: PaymentCardField[] = [
      "cvv",
      "billing_zip",
      "card_number",
      "cardholder_name",
      "expiry_year",
      "expiry_month",
      "expiry_combined",
    ];
    expect(orderPaymentFillFields(all)).toEqual([
      "expiry_combined",
      "expiry_month",
      "expiry_year",
      "cardholder_name",
      "billing_zip",
      "card_number",
      "cvv",
    ]);
  });

  it("does not mutate the input array", () => {
    const queued: PaymentCardField[] = ["cvv", "cardholder_name"];
    orderPaymentFillFields(queued);
    expect(queued).toEqual(["cvv", "cardholder_name"]);
  });

  it("is a no-op for parent-page-only batches", () => {
    expect(orderPaymentFillFields(["expiry_combined", "cardholder_name"])).toEqual([
      "expiry_combined",
      "cardholder_name",
    ]);
  });
});
