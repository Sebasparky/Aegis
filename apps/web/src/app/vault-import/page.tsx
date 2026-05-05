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
    } catch (err: any) {
      setImportError(err.message ?? "Import failed. Please try again.");
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
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-white">Import Credentials</h1>
        <p className="mt-1 text-sm text-gray-400">
          Upload a CSV export from Chrome, Google Password Manager, or Apple Passwords. Passwords are
          encrypted into the Aegis vault immediately — the raw CSV is never stored on the server.
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
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-8 text-center space-y-3">
          <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-sm text-gray-300">Encrypting and storing credentials…</p>
          <p className="text-xs text-gray-500">This may take a moment for large imports.</p>
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
    <div className="space-y-4">
      <div className="bg-amber-950 border border-amber-700 rounded-lg px-4 py-3">
        <p className="text-xs text-amber-300 font-medium">CSV files contain plaintext passwords</p>
        <p className="text-xs text-amber-500 mt-0.5">
          We recommend deleting the CSV file from your computer after import. Aegis encrypts
          passwords immediately and never stores the raw file.
        </p>
      </div>

      <div
        className={`border-2 border-dashed rounded-lg p-10 text-center cursor-pointer transition-colors ${
          dragging ? "border-indigo-400 bg-indigo-950/30" : "border-gray-700 hover:border-gray-500"
        }`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { setDragging(false); onDrop(e); }}
        onClick={() => fileInputRef.current?.click()}
      >
        <p className="text-sm text-gray-300 font-medium">Drop your CSV here or click to choose a file</p>
        <p className="text-xs text-gray-500 mt-1">Accepts .csv files only</p>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={onFileInput}
        />
      </div>

      {parseError && (
        <p className="text-sm text-red-400">{parseError}</p>
      )}

      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-2">
        <p className="text-xs text-gray-400 font-medium">Supported formats</p>
        <div className="space-y-1 text-xs text-gray-500">
          <p>
            <span className="text-gray-300">Chrome / Google Password Manager</span> —
            {" "}name, url, username, password, note
          </p>
          <p>
            <span className="text-gray-300">Apple Passwords</span> —
            {" "}Title, URL, Username, Password, Notes, OTPAuth
          </p>
          <p>
            <span className="text-gray-300">Generic</span> — any CSV with url/website, username/login,
            and password columns (case-insensitive headers)
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
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <p className="text-sm text-gray-300">
            <span className="font-medium text-white">{rows.length}</span> credential
            {rows.length !== 1 ? "s" : ""} found
            {importFormat !== "unknown" && (
              <span className="text-gray-500"> · {FORMAT_LABELS[importFormat] ?? importFormat}</span>
            )}
          </p>
          <p className="text-xs text-gray-500">
            {selectedRows.length} selected
            {duplicateCount > 0 && ` · ${duplicateCount} possible duplicate${duplicateCount !== 1 ? "s" : ""} (unchecked by default)`}
            {skippedRows > 0 && ` · ${skippedRows} row${skippedRows !== 1 ? "s" : ""} skipped (missing domain, username, or password)`}
          </p>
        </div>
        <button
          onClick={onReset}
          className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
        >
          Start over
        </button>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800">
              <th className="px-4 py-2 text-left w-10">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={(e) => onToggleAll(e.target.checked)}
                  className="accent-indigo-500"
                />
              </th>
              <th className="px-4 py-2 text-left text-xs text-gray-500 font-medium">Credential</th>
              <th className="px-4 py-2 text-left text-xs text-gray-500 font-medium">Username</th>
              <th className="px-4 py-2 text-left text-xs text-gray-500 font-medium">Password</th>
              <th className="px-4 py-2 text-left text-xs text-gray-500 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const provider = findCredentialProviderByDomain(row.normalizedDomain);
              const providerLabel = provider ? provider.display_name : row.normalizedDomain;
              return (
                <tr
                  key={i}
                  className={`border-b border-gray-800 last:border-0 ${row.isDuplicate ? "opacity-60" : ""}`}
                >
                  <td className="px-4 py-2.5">
                    <input
                      type="checkbox"
                      checked={row.selected}
                      onChange={() => onToggleRow(i)}
                      className="accent-indigo-500"
                    />
                  </td>
                  <td className="px-4 py-2.5">
                    <p className="text-white text-xs font-medium">{row.label}</p>
                    <p className="text-gray-500 text-xs">{providerLabel} · {row.normalizedDomain}</p>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-gray-300">{row.username}</td>
                  <td className="px-4 py-2.5 text-xs text-gray-500 tracking-widest">••••••••</td>
                  <td className="px-4 py-2.5">
                    {row.isDuplicate ? (
                      <span className="text-xs bg-amber-900 text-amber-300 px-1.5 py-0.5 rounded">
                        Possible duplicate
                      </span>
                    ) : (
                      <span className="text-xs bg-gray-800 text-gray-400 px-1.5 py-0.5 rounded">
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
        <p className="text-sm text-red-400">{importError}</p>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={onImport}
          disabled={selectedRows.length === 0}
          className="bg-indigo-500 hover:bg-indigo-400 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-2 rounded-md transition-colors"
        >
          Import {selectedRows.length > 0 ? `${selectedRows.length} ` : ""}selected
        </button>
        <p className="text-xs text-gray-500">
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
    <div className="space-y-4">
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-5 space-y-4">
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-full bg-green-900 flex items-center justify-center shrink-0">
            <svg className="w-4 h-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <div>
            <p className="text-sm font-medium text-white">
              Imported {result.total_imported} credential{result.total_imported !== 1 ? "s" : ""}
            </p>
            {result.failed.length > 0 && (
              <p className="text-xs text-amber-400 mt-0.5">
                {result.failed.length} entr{result.failed.length !== 1 ? "ies" : "y"} could not be imported.
              </p>
            )}
          </div>
        </div>

        <div className="border border-gray-800 rounded-md px-4 py-3 space-y-1 text-xs text-gray-400">
          <p>Raw CSV was not stored on the server.</p>
          <p>Passwords were encrypted into the Aegis vault. Agents cannot read them.</p>
        </div>

        {result.imported.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs text-gray-500 font-medium">Imported credentials</p>
            <div className="space-y-1">
              {result.imported.map((vp) => {
                const provider = findCredentialProviderByDomain(vp.domain);
                const label = provider ? `${provider.display_name} · ${vp.username ?? vp.domain}` : `${vp.domain} · ${vp.username ?? ""}`;
                return (
                  <div key={vp.pass_id} className="flex items-center gap-2 text-xs text-gray-300">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
                    <span>{label}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <div className="bg-amber-950 border border-amber-700 rounded-lg px-4 py-3">
        <p className="text-xs text-amber-300 font-medium">Delete your CSV file</p>
        <p className="text-xs text-amber-500 mt-0.5">
          Your export CSV contains plaintext passwords. Now that import is complete, we recommend
          deleting it from your computer.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <a
          href="/passes"
          className="bg-indigo-500 hover:bg-indigo-400 text-white text-sm font-medium px-4 py-2 rounded-md transition-colors"
        >
          View your credentials
        </a>
        <button
          onClick={onImportMore}
          className="text-sm text-gray-400 hover:text-white transition-colors"
        >
          Import more
        </button>
      </div>
    </div>
  );
}
