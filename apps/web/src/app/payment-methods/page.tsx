"use client";

import { useEffect, useState } from "react";
import {
  listPaymentMethods,
  createPaymentMethod,
  updatePaymentMethod,
  archivePaymentMethod,
  deletePaymentMethod,
} from "@/lib/api";
import type { PaymentMethodView, PaymentMethodBrand } from "@/lib/api";
import { SpotlightHeroCard } from "@/components/spotlight-hero-card";

// ── Brand helpers ─────────────────────────────────────────────────────────────

function brandLabel(brand: PaymentMethodBrand): string {
  const map: Record<PaymentMethodBrand, string> = {
    visa: "Visa", mastercard: "Mastercard", amex: "Amex",
    discover: "Discover", unknown: "Card",
  };
  return map[brand];
}

function brandStatusClass(brand: PaymentMethodBrand): string {
  if (brand === "visa")       return "a-status--green";
  if (brand === "mastercard") return "a-status--amber";
  return "a-status--graphite";
}

function fmtExpiry(month: number, year: number): string {
  return `${String(month).padStart(2, "0")} / ${year}`;
}

// ── Types ─────────────────────────────────────────────────────────────────────

type Tab = "cards" | "add";

// ── Page ─────────────────────────────────────────────────────────────────────

export default function PaymentMethodsPage() {
  const [cards, setCards]   = useState<PaymentMethodView[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab]       = useState<Tab>("cards");

  // Form state
  const [label,          setLabel]          = useState("");
  const [cardholderName, setCardholderName] = useState("");
  const [cardNumber,     setCardNumber]     = useState("");
  const [cvv,            setCvv]            = useState("");
  const [expMonth,       setExpMonth]       = useState("");
  const [expYear,        setExpYear]        = useState("");
  const [billingZip,     setBillingZip]     = useState("");
  const [billingCountry, setBillingCountry] = useState("");
  const [formError,      setFormError]      = useState<string | null>(null);
  const [saving,         setSaving]         = useState(false);
  const [savedMsg,       setSavedMsg]       = useState<string | null>(null);

  async function load() {
    const data = await listPaymentMethods();
    setCards(data);
  }

  useEffect(() => { load().finally(() => setLoading(false)); }, []);

  function clearForm() {
    setLabel("");
    setCardholderName("");
    setCardNumber("");
    setCvv("");
    setExpMonth("");
    setExpYear("");
    setBillingZip("");
    setBillingCountry("");
    setFormError(null);
  }

  async function handleAddCard(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!label.trim())          { setFormError("Label is required.");          return; }
    if (!cardholderName.trim()) { setFormError("Cardholder name is required."); return; }
    if (!cardNumber.trim())     { setFormError("Card number is required.");     return; }
    if (!cvv.trim())            { setFormError("CVV is required.");             return; }
    if (!expMonth)              { setFormError("Expiry month is required.");    return; }
    if (!expYear)               { setFormError("Expiry year is required.");     return; }

    setSaving(true);
    try {
      // Clear sensitive fields from state immediately before the async call
      // so they are not accessible for longer than necessary.
      const capturedCard = cardNumber;
      const capturedCvv  = cvv;
      setCardNumber("");
      setCvv("");

      await createPaymentMethod({
        label:           label.trim(),
        cardholder_name: cardholderName.trim(),
        card_number:     capturedCard,
        cvv:             capturedCvv,
        exp_month:       Number(expMonth),
        exp_year:        Number(expYear),
        billing_zip:     billingZip.trim() || undefined,
        billing_country: billingCountry.trim() || undefined,
      });

      clearForm();
      setSavedMsg("Card saved. Full number and CVV are not stored.");
      setTimeout(() => setSavedMsg(null), 4000);
      await load();
      setTab("cards");
    } catch (err: any) {
      setFormError(err.message ?? "Failed to save card.");
    } finally {
      setSaving(false);
    }
  }

  async function handleSetDefault(pmId: string) {
    try {
      await updatePaymentMethod(pmId, { is_default: true });
      await load();
    } catch {
      alert("Failed to set default.");
    }
  }

  async function handleArchive(pm: PaymentMethodView) {
    if (!confirm(`Archive "${pm.label}" ending in ${pm.last4}? You can delete it afterwards.`)) return;
    try {
      await archivePaymentMethod(pm.payment_method_id);
      await load();
    } catch {
      alert("Failed to archive card.");
    }
  }

  async function handleDelete(pm: PaymentMethodView) {
    if (!confirm(`Permanently delete "${pm.label}" ending in ${pm.last4}? This cannot be undone.`)) return;
    try {
      await deletePaymentMethod(pm.payment_method_id);
      await load();
    } catch {
      alert("Failed to delete card.");
    }
  }

  const activeCards   = cards.filter((c) => c.status === "active");
  const archivedCards = cards.filter((c) => c.status === "archived");

  if (loading) {
    return (
      <div style={{ padding: "32px", color: "var(--ink-3)", fontSize: 14 }}>
        Loading payment methods…
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24, maxWidth: 760 }}>
      {/* Hero */}
      <SpotlightHeroCard className="cmd-hero cmd-hero--ceramic">
        <div className="cmd-hero__inner">
          <div className="cmd-hero__icon">
            <svg width={28} height={28} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="2" y="5" width="20" height="14" rx="2"/>
              <path d="M2 10h20"/>
            </svg>
          </div>
          <div>
            <div className="cmd-hero__title">Payment Methods</div>
            <div className="cmd-hero__subtitle">
              {activeCards.length} active card{activeCards.length !== 1 ? "s" : ""}
              {" — "}full card numbers and CVV are never stored or displayed after saving.
            </div>
          </div>
        </div>
      </SpotlightHeroCard>

      {/* Dev-only warning */}
      <div
        style={{
          background: "color-mix(in oklch, var(--amber) 12%, transparent)",
          border: "1px solid color-mix(in oklch, var(--amber) 35%, transparent)",
          borderRadius: "var(--r-2)",
          padding: "10px 14px",
          fontSize: 13,
          color: "var(--ink-2)",
          lineHeight: 1.5,
        }}
      >
        <strong>Local / dev vault only.</strong> Card numbers are sent to the local API over
        localhost and encrypted with the dev KMS key. Do not store real card details until
        production-grade TLS, cloud KMS, and Supabase persistence are fully configured.
      </div>

      {/* Tabs */}
      <div className="ag-tabs">
        <button className={`ag-tab${tab === "cards" ? " ag-tab--active" : ""}`} onClick={() => setTab("cards")}>
          Saved cards ({activeCards.length})
        </button>
        <button className={`ag-tab${tab === "add" ? " ag-tab--active" : ""}`} onClick={() => setTab("add")}>
          Add card
        </button>
      </div>

      {/* ── Cards tab ── */}
      {tab === "cards" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {activeCards.length === 0 && archivedCards.length === 0 && (
            <div
              style={{
                padding: "32px 24px",
                textAlign: "center",
                color: "var(--ink-3)",
                fontSize: 14,
                background: "var(--bg-2)",
                borderRadius: "var(--r-2)",
                border: "1px dashed var(--graphite)",
              }}
            >
              No payment methods saved yet.{" "}
              <button className="a-btn a-btn--ghost" style={{ display: "inline", padding: "0 4px" }} onClick={() => setTab("add")}>
                Add a card
              </button>
            </div>
          )}

          {activeCards.map((pm) => (
            <CardRow
              key={pm.payment_method_id}
              pm={pm}
              onSetDefault={handleSetDefault}
              onArchive={handleArchive}
              onDelete={handleDelete}
            />
          ))}

          {archivedCards.length > 0 && (
            <>
              <div style={{ fontSize: 12, color: "var(--ink-4)", marginTop: 8, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                Archived
              </div>
              {archivedCards.map((pm) => (
                <CardRow
                  key={pm.payment_method_id}
                  pm={pm}
                  onSetDefault={handleSetDefault}
                  onArchive={handleArchive}
                  onDelete={handleDelete}
                />
              ))}
            </>
          )}
        </div>
      )}

      {/* ── Add card tab ── */}
      {tab === "add" && (
        <div className="a-card" style={{ padding: "24px 20px" }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 18 }}>New payment method</div>

          {savedMsg && (
            <div
              style={{
                background: "color-mix(in oklch, var(--green) 12%, transparent)",
                border: "1px solid color-mix(in oklch, var(--green) 30%, transparent)",
                borderRadius: "var(--r-1)",
                padding: "8px 12px",
                fontSize: 13,
                color: "var(--ink-2)",
                marginBottom: 16,
              }}
            >
              {savedMsg}
            </div>
          )}

          <form onSubmit={handleAddCard} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <label className="ag-label">Label *</label>
                <input
                  className="ag-input"
                  type="text"
                  placeholder="e.g. Personal Visa"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  autoComplete="off"
                />
              </div>
              <div>
                <label className="ag-label">Cardholder name *</label>
                <input
                  className="ag-input"
                  type="text"
                  placeholder="Jane Doe"
                  value={cardholderName}
                  onChange={(e) => setCardholderName(e.target.value)}
                  autoComplete="cc-name"
                />
              </div>
            </div>

            <div>
              <label className="ag-label">Card number *</label>
              <input
                className="ag-input"
                type="text"
                inputMode="numeric"
                placeholder="•••• •••• •••• ••••"
                value={cardNumber}
                onChange={(e) => setCardNumber(e.target.value)}
                autoComplete="cc-number"
                maxLength={19}
              />
              <div style={{ fontSize: 11, color: "var(--ink-4)", marginTop: 4 }}>
                Only the last 4 digits are stored after saving — full number is encrypted immediately.
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
              <div>
                <label className="ag-label">CVV *</label>
                <input
                  className="ag-input"
                  type="password"
                  placeholder="•••"
                  value={cvv}
                  onChange={(e) => setCvv(e.target.value)}
                  autoComplete="cc-csc"
                  maxLength={4}
                />
                <div style={{ fontSize: 11, color: "var(--ink-4)", marginTop: 4 }}>
                  Never displayed after saving.
                </div>
              </div>
              <div>
                <label className="ag-label">Exp. month *</label>
                <select
                  className="ag-input"
                  value={expMonth}
                  onChange={(e) => setExpMonth(e.target.value)}
                  autoComplete="cc-exp-month"
                >
                  <option value="">MM</option>
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                    <option key={m} value={m}>{String(m).padStart(2, "0")}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="ag-label">Exp. year *</label>
                <select
                  className="ag-input"
                  value={expYear}
                  onChange={(e) => setExpYear(e.target.value)}
                  autoComplete="cc-exp-year"
                >
                  <option value="">YYYY</option>
                  {Array.from({ length: 12 }, (_, i) => new Date().getFullYear() + i).map((y) => (
                    <option key={y} value={y}>{y}</option>
                  ))}
                </select>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <label className="ag-label">Billing ZIP / Postal code</label>
                <input
                  className="ag-input"
                  type="text"
                  placeholder="Optional"
                  value={billingZip}
                  onChange={(e) => setBillingZip(e.target.value)}
                  autoComplete="postal-code"
                />
              </div>
              <div>
                <label className="ag-label">Billing country</label>
                <input
                  className="ag-input"
                  type="text"
                  placeholder="Optional (e.g. US)"
                  value={billingCountry}
                  onChange={(e) => setBillingCountry(e.target.value)}
                  autoComplete="country"
                  maxLength={2}
                />
              </div>
            </div>

            {formError && (
              <div style={{ fontSize: 13, color: "var(--red)", padding: "6px 0" }}>
                {formError}
              </div>
            )}

            <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
              <button
                type="submit"
                className="a-btn a-btn--primary"
                disabled={saving}
              >
                {saving ? "Encrypting…" : "Save card"}
              </button>
              <button
                type="button"
                className="a-btn a-btn--ghost"
                onClick={clearForm}
                disabled={saving}
              >
                Clear
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

// ── Card row component ────────────────────────────────────────────────────────

function CardRow({
  pm,
  onSetDefault,
  onArchive,
  onDelete,
}: {
  pm: PaymentMethodView;
  onSetDefault: (id: string) => void;
  onArchive: (pm: PaymentMethodView) => void;
  onDelete: (pm: PaymentMethodView) => void;
}) {
  const archived = pm.status === "archived";
  return (
    <div
      className="ag-row"
      style={{
        opacity: archived ? 0.6 : 1,
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "12px 16px",
      }}
    >
      {/* Brand indicator */}
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: "var(--r-1)",
          background: "var(--bg-2)",
          border: "1px solid var(--graphite)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 11,
          fontWeight: 700,
          textTransform: "uppercase",
          color: "var(--ink-2)",
          flexShrink: 0,
          letterSpacing: "0.04em",
        }}
      >
        {brandLabel(pm.brand).slice(0, 2)}
      </div>

      {/* Card info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>{pm.label}</span>
          {pm.is_default && (
            <span className="a-status a-status--green" style={{ fontSize: 11 }}>
              <span className="a-status__dot" />
              Default
            </span>
          )}
          {archived && (
            <span className="a-status a-status--graphite" style={{ fontSize: 11 }}>
              Archived
            </span>
          )}
        </div>
        <div style={{ fontSize: 13, color: "var(--ink-3)", marginTop: 2 }}>
          {brandLabel(pm.brand)} •••• •••• •••• {pm.last4}
          {" · "}
          {pm.cardholder_name}
          {" · "}
          Exp {fmtExpiry(pm.exp_month, pm.exp_year)}
        </div>
      </div>

      {/* Actions */}
      {!archived && (
        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          {!pm.is_default && (
            <button
              className="a-btn a-btn--ghost"
              style={{ fontSize: 12, padding: "4px 10px" }}
              onClick={() => onSetDefault(pm.payment_method_id)}
            >
              Set default
            </button>
          )}
          <button
            className="a-btn a-btn--ghost"
            style={{ fontSize: 12, padding: "4px 10px" }}
            onClick={() => onArchive(pm)}
          >
            Archive
          </button>
        </div>
      )}
      {archived && (
        <button
          className="a-btn a-btn--danger"
          style={{ fontSize: 12, padding: "4px 10px", flexShrink: 0 }}
          onClick={() => onDelete(pm)}
        >
          Delete
        </button>
      )}
    </div>
  );
}
