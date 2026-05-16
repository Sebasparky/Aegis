"use client";

import { useState, useRef, useCallback } from "react";
import { parseCredentialCsv } from "@/lib/csvImport";
import type { ParsedCredential } from "@/lib/csvImport";
import { findCredentialProviderByDomain, normalizeLoginDomain } from "@/lib/credentialProviders";
import { listVaultPasses, importVaultPasses } from "@/lib/api";
import type { VaultPassView } from "@/lib/api";

type FlowState = "upload" | "preview" | "importing" | "complete";

interface PreviewRow extends ParsedCredential {
  isDuplicate: boolean;
  selected: boolean;
}

const FORMAT_LABELS: Record<string, string> = {
  chrome: "Chrome / Google Password Manager",
  apple: "Apple Passwords",
  generic: "Generic CSV",
  unknown: "Unknown",
};

export default function VaultImportPage() {
  const [flow, setFlow] = useState<FlowState>("upload");
  const [rows, setRows] = useState<PreviewRow[]>([]);
  const [skippedRows, setSkippedRows] = useState(0);
  const [importFormat, setImportFormat] = useState<string>("unknown");
  const [parseError, setParseError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<{
    imported: VaultPassView[];
    failed: Array<{ index: number; reason: string }>;
    total_requested: number;
    total_imported: number;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function processFile(file: File) {
    setParseError(null);
    let text: string;
    try {
      text = await file.text();
    } catch {
      setParseError("Could not read the file. Make sure it is a plain text CSV.");
      return;
    }

    const result = parseCredentialCsv(text);

    if (result.credentials.length === 0 && result.skippedRows === 0 && result.format === "unknown") {
      setParseError("No credentials found. Check that the file has a header row and at least one data row.");
      return;
    }

    let existing: VaultPassView[] = [];
    try {
      existing = await listVaultPasses();
    } catch {
      // Non-fatal — duplicate detection falls back to no duplicates.
    }

    const existingKeys = new Set(
      existing.map((e) => `${normalizeLoginDomain(e.domain)}|${(e.username ?? "").toLowerCase()}`)
    );

    const previewRows: PreviewRow[] = result.credentials.map((c) => {
      const key = `${c.normalizedDomain}|${c.username.toLowerCase()}`;
      const isDuplicate = existingKeys.has(key);
      return { ...c, isDuplicate, selected: !isDuplicate };
    });

    setRows(previewRows);
    setSkippedRows(result.skippedRows);
    setImportFormat(result.format);
    setFlow("preview");
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) processFile(file);
    e.target.value = "";
  }

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) processFile(file);
  }, []);

  function toggleRow(idx: number) {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, selected: !r.selected } : r)));
  }

  function toggleAll(val: boolean) {
    setRows((prev) => prev.map((r) => ({ ...r, selected: val })));
  }

  const selectedRows = rows.filter((r) => r.selected);
  const duplicateCount = rows.filter((r) => r.isDuplicate).length;

  async function handleImport() {
    if (selectedRows.length === 0) return;
    setImportError(null);
    setFlow("importing");
    try {
      const result = await importVaultPasses(
        selectedRows.map((r) => ({
          label: r.label,
          kind: "login_password" as const,
          domain: r.normalizedDomain,
          username: r.username,
          password: r.password,
        }))
      );
      setImportResult(result);
      setFlow("complete");
    } catch (err: unknown) {
      setImportError(err instanceof Error ? err.message : "Import failed. Please try again.");
      setFlow("preview");
    }
  }

  function reset() {
    setFlow("upload");
    setRows([]);
    setSkippedRows(0);
    setImportFormat("unknown");
    setParseError(null);
    setImportError(null);
    setImportResult(null);
  }

  return (
    <div className="page">

      {/* ── Header ── */}
      <div style={{ marginBottom: 24 }}>
        <span className="a-eyebrow">Secrets · Import</span>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "var(--ink-1)", margin: "4px 0 6px" }}>
          Import credentials
        </h1>
        <p style={{ fontSize: 13.5, color: "var(--ink-3)", maxWidth: 520, margin: 0, lineHeight: 1.5 }}>
          Upload a CSV export from Chrome, Google Password Manager, or Apple Passwords. Passwords
          are encrypted into the Antigen vault immediately — the raw CSV is never stored on the server.
        </p>
      </div>

      {flow === "upload" && (
        <UploadStep
          parseError={parseError}
          fileInputRef={fileInputRef}
          onFileInput={handleFileInput}
          onDrop={handleDrop}
        />
      )}

      {flow === "preview" && (
        <PreviewStep
          rows={rows}
          skippedRows={skippedRows}
          importFormat={importFormat}
          selectedRows={selectedRows}
          duplicateCount={duplicateCount}
          importError={importError}
          onToggleRow={toggleRow}
          onToggleAll={toggleAll}
          onImport={handleImport}
          onReset={reset}
        />
      )}

      {flow === "importing" && (
        <div style={{ border: "1px solid var(--hairline)", borderRadius: "var(--r-3)", padding: "48px 32px", textAlign: "center" }}>
          <div style={{
            width: 28, height: 28, borderRadius: "50%",
            border: "2px solid var(--hairline)", borderTopColor: "var(--ink-1)",
            animation: "spin 0.8s linear infinite", margin: "0 auto 16px",
          }} />
          <p style={{ fontSize: 14, color: "var(--ink-2)", margin: "0 0 4px" }}>Encrypting and storing credentials…</p>
          <p style={{ fontSize: 12, color: "var(--ink-4)", margin: 0 }}>This may take a moment for large imports.</p>
        </div>
      )}

      {flow === "complete" && importResult && (
        <CompleteStep result={importResult} onImportMore={reset} />
      )}

    </div>
  );
}

function UploadStep({
  parseError,
  fileInputRef,
  onFileInput,
  onDrop,
}: {
  parseError: string | null;
  fileInputRef: React.RefObject<HTMLInputElement>;
  onFileInput: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
}) {
  const [dragging, setDragging] = useState(false);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Warning banner */}
      <div style={{ background: "var(--amber-soft)", border: "1px solid var(--amber-ring)", borderRadius: "var(--r-3)", padding: "12px 16px" }}>
        <p style={{ fontSize: 12.5, fontWeight: 600, color: "var(--amber)", margin: "0 0 2px" }}>
          CSV files contain plaintext passwords
        </p>
        <p style={{ fontSize: 12, color: "oklch(0.55 0.08 70)", margin: 0, lineHeight: 1.45 }}>
          We recommend deleting the CSV file from your computer after import. Antigen encrypts
          passwords immediately and never stores the raw file.
        </p>
      </div>

      {/* Drop zone */}
      <div
        style={{
          border: `2px dashed ${dragging ? "var(--ink-2)" : "var(--hairline)"}`,
          borderRadius: "var(--r-3)",
          padding: "48px 32px",
          textAlign: "center",
          cursor: "pointer",
          background: dragging ? "var(--graphite-soft)" : "transparent",
          transition: "border-color 0.15s, background 0.15s",
        }}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { setDragging(false); onDrop(e); }}
        onClick={() => fileInputRef.current?.click()}
      >
        <p style={{ fontSize: 14, fontWeight: 500, color: "var(--ink-2)", margin: "0 0 4px" }}>
          Drop your CSV here or click to choose a file
        </p>
        <p style={{ fontSize: 12, color: "var(--ink-4)", margin: 0 }}>Accepts .csv files only</p>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          style={{ display: "none" }}
          onChange={onFileInput}
        />
      </div>

      {parseError && (
        <p style={{ fontSize: 13, color: "var(--red)", margin: 0 }}>{parseError}</p>
      )}

      {/* Supported formats */}
      <div style={{ border: "1px solid var(--hairline)", borderRadius: "var(--r-3)", padding: "14px 18px" }}>
        <p style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-2)", margin: "0 0 8px" }}>Supported formats</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--ink-4)", lineHeight: 1.45 }}>
          <p style={{ margin: 0 }}>
            <span style={{ color: "var(--ink-2)" }}>Chrome / Google Password Manager</span>
            {" "}— name, url, username, password, note
          </p>
          <p style={{ margin: 0 }}>
            <span style={{ color: "var(--ink-2)" }}>Apple Passwords</span>
            {" "}— Title, URL, Username, Password, Notes, OTPAuth
          </p>
          <p style={{ margin: 0 }}>
            <span style={{ color: "var(--ink-2)" }}>Generic</span>
            {" "}— any CSV with url/website, username/login, and password columns (case-insensitive headers)
          </p>
        </div>
      </div>
    </div>
  );
}

function PreviewStep({
  rows,
  skippedRows,
  importFormat,
  selectedRows,
  duplicateCount,
  importError,
  onToggleRow,
  onToggleAll,
  onImport,
  onReset,
}: {
  rows: PreviewRow[];
  skippedRows: number;
  importFormat: string;
  selectedRows: PreviewRow[];
  duplicateCount: number;
  importError: string | null;
  onToggleRow: (i: number) => void;
  onToggleAll: (val: boolean) => void;
  onImport: () => void;
  onReset: () => void;
}) {
  const allSelected = rows.length > 0 && rows.every((r) => r.selected);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Summary row */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
        <div>
          <p style={{ fontSize: 13.5, color: "var(--ink-1)", margin: "0 0 2px" }}>
            <strong>{rows.length}</strong> credential{rows.length !== 1 ? "s" : ""} found
            {importFormat !== "unknown" && (
              <span style={{ color: "var(--ink-4)" }}> · {FORMAT_LABELS[importFormat] ?? importFormat}</span>
            )}
          </p>
          <p style={{ fontSize: 12, color: "var(--ink-4)", margin: 0 }}>
            {selectedRows.length} selected
            {duplicateCount > 0 && ` · ${duplicateCount} possible duplicate${duplicateCount !== 1 ? "s" : ""} (unchecked by default)`}
            {skippedRows > 0 && ` · ${skippedRows} row${skippedRows !== 1 ? "s" : ""} skipped (missing domain, username, or password)`}
          </p>
        </div>
        <button
          onClick={onReset}
          style={{ fontSize: 12, color: "var(--ink-4)", background: "none", border: "none", padding: 0, cursor: "pointer" }}
        >
          Start over
        </button>
      </div>

      {/* Table */}
      <div style={{ border: "1px solid var(--hairline)", borderRadius: "var(--r-3)", overflow: "hidden" }}>
        <table style={{ width: "100%", fontSize: 12.5, borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--hairline)" }}>
              <th style={{ padding: "10px 14px", textAlign: "left", width: 40 }}>
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={(e) => onToggleAll(e.target.checked)}
                />
              </th>
              <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 11.5, color: "var(--ink-4)", fontWeight: 500 }}>Credential</th>
              <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 11.5, color: "var(--ink-4)", fontWeight: 500 }}>Username</th>
              <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 11.5, color: "var(--ink-4)", fontWeight: 500 }}>Password</th>
              <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 11.5, color: "var(--ink-4)", fontWeight: 500 }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const provider = findCredentialProviderByDomain(row.normalizedDomain);
              const providerLabel = provider ? provider.display_name : row.normalizedDomain;
              return (
                <tr
                  key={i}
                  style={{
                    borderBottom: i < rows.length - 1 ? "1px solid var(--hairline)" : undefined,
                    opacity: row.isDuplicate ? 0.6 : 1,
                  }}
                >
                  <td style={{ padding: "10px 14px" }}>
                    <input
                      type="checkbox"
                      checked={row.selected}
                      onChange={() => onToggleRow(i)}
                    />
                  </td>
                  <td style={{ padding: "10px 14px" }}>
                    <p style={{ fontSize: 12.5, fontWeight: 500, color: "var(--ink-1)", margin: "0 0 1px" }}>{row.label}</p>
                    <p style={{ fontSize: 11.5, color: "var(--ink-4)", margin: 0 }}>{providerLabel} · {row.normalizedDomain}</p>
                  </td>
                  <td style={{ padding: "10px 14px", fontSize: 12.5, color: "var(--ink-2)" }}>{row.username}</td>
                  <td style={{ padding: "10px 14px", fontSize: 12.5, color: "var(--ink-4)", letterSpacing: "0.12em" }}>••••••••</td>
                  <td style={{ padding: "10px 14px" }}>
                    {row.isDuplicate ? (
                      <span style={{
                        fontSize: 10.5, padding: "1px 7px", borderRadius: 999,
                        background: "var(--amber-soft)", color: "var(--amber)", border: "1px solid var(--amber-ring)",
                      }}>
                        Possible duplicate
                      </span>
                    ) : (
                      <span style={{
                        fontSize: 10.5, padding: "1px 7px", borderRadius: 999,
                        background: "var(--graphite-soft)", color: "var(--ink-3)", border: "1px solid var(--hairline)",
                      }}>
                        Ready
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {importError && (
        <p style={{ fontSize: 13, color: "var(--red)", margin: 0 }}>{importError}</p>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button
          onClick={onImport}
          disabled={selectedRows.length === 0}
          className="a-btn a-btn--primary"
        >
          Import {selectedRows.length > 0 ? `${selectedRows.length} ` : ""}selected
        </button>
        <p style={{ fontSize: 12, color: "var(--ink-4)", margin: 0 }}>
          Passwords are encrypted immediately. The CSV is not sent to the server.
        </p>
      </div>
    </div>
  );
}

function CompleteStep({
  result,
  onImportMore,
}: {
  result: {
    imported: VaultPassView[];
    failed: Array<{ index: number; reason: string }>;
    total_requested: number;
    total_imported: number;
  };
  onImportMore: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Success card */}
      <div style={{ border: "1px solid var(--green-ring)", borderRadius: "var(--r-3)", padding: "20px 24px", background: "var(--green-soft)" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 16 }}>
          <div style={{
            width: 28, height: 28, borderRadius: "50%",
            background: "var(--green)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
          }}>
            <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="white" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <div>
            <p style={{ fontSize: 14, fontWeight: 600, color: "var(--ink-1)", margin: "0 0 2px" }}>
              Imported {result.total_imported} credential{result.total_imported !== 1 ? "s" : ""}
            </p>
            {result.failed.length > 0 && (
              <p style={{ fontSize: 12, color: "var(--amber)", margin: 0 }}>
                {result.failed.length} entr{result.failed.length !== 1 ? "ies" : "y"} could not be imported.
              </p>
            )}
          </div>
        </div>

        <div style={{ border: "1px solid var(--green-ring)", borderRadius: "var(--r-2)", padding: "10px 14px", fontSize: 12, color: "oklch(0.42 0.09 150)", lineHeight: 1.55 }}>
          <p style={{ margin: "0 0 2px" }}>Raw CSV was not stored on the server.</p>
          <p style={{ margin: 0 }}>Passwords were encrypted into the Antigen vault. Agents cannot read them.</p>
        </div>

        {result.imported.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <p style={{ fontSize: 11.5, fontWeight: 500, color: "oklch(0.42 0.09 150)", margin: "0 0 6px" }}>Imported credentials</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {result.imported.map((vp) => {
                const provider = findCredentialProviderByDomain(vp.domain);
                const label = provider
                  ? `${provider.display_name} · ${vp.username ?? vp.domain}`
                  : `${vp.domain} · ${vp.username ?? ""}`;
                return (
                  <div key={vp.pass_id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--ink-2)" }}>
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--green)", flexShrink: 0 }} />
                    <span>{label}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Delete CSV reminder */}
      <div style={{ background: "var(--amber-soft)", border: "1px solid var(--amber-ring)", borderRadius: "var(--r-3)", padding: "12px 16px" }}>
        <p style={{ fontSize: 12.5, fontWeight: 600, color: "var(--amber)", margin: "0 0 2px" }}>Delete your CSV file</p>
        <p style={{ fontSize: 12, color: "oklch(0.55 0.08 70)", margin: 0, lineHeight: 1.45 }}>
          Your export CSV contains plaintext passwords. Now that import is complete, we recommend
          deleting it from your computer.
        </p>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <a href="/passes" className="a-btn a-btn--primary">
          View your credentials
        </a>
        <button
          onClick={onImportMore}
          className="a-btn a-btn--ghost"
        >
          Import more
        </button>
      </div>
    </div>
  );
}
