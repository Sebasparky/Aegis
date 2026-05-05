import { normalizeLoginDomain } from "./credentialProviders";

export interface ParsedCredential {
  rowIndex: number;
  label: string;
  url: string;
  normalizedDomain: string;
  username: string;
  password: string; // in-memory only — never log
  source: "chrome" | "apple" | "generic";
}

export interface CsvParseResult {
  credentials: ParsedCredential[];
  skippedRows: number;
  format: "chrome" | "apple" | "generic" | "unknown";
}

// Splits a single CSV line respecting double-quoted fields and escaped quotes ("").
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

export function parseCredentialCsv(csvText: string): CsvParseResult {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) return { credentials: [], skippedRows: 0, format: "unknown" };

  const headerFields = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());

  let format: "chrome" | "apple" | "generic" = "generic";
  if (headerFields.includes("otpauth")) {
    format = "apple";
  } else if (headerFields.includes("note") && !headerFields.includes("notes")) {
    format = "chrome";
  }

  // Returns the first column index that matches any of the candidate names.
  const findCol = (...candidates: string[]): number => {
    for (const c of candidates) {
      const idx = headerFields.indexOf(c);
      if (idx !== -1) return idx;
    }
    return -1;
  };

  const urlCol = findCol("url", "website");
  const labelCol = findCol("name", "title");
  const usernameCol = findCol("username", "login");
  const passwordCol = findCol("password");

  const credentials: ParsedCredential[] = [];
  let skippedRows = 0;

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    const url = urlCol >= 0 ? (fields[urlCol] ?? "").trim() : "";
    const rawLabel = labelCol >= 0 ? (fields[labelCol] ?? "").trim() : "";
    const username = usernameCol >= 0 ? (fields[usernameCol] ?? "").trim() : "";
    const password = passwordCol >= 0 ? (fields[passwordCol] ?? "") : "";

    const normalizedDomain = normalizeLoginDomain(url);

    if (!normalizedDomain || !username || !password) {
      skippedRows++;
      continue;
    }

    credentials.push({
      rowIndex: i,
      label: rawLabel || normalizedDomain,
      url,
      normalizedDomain,
      username,
      password,
      source: format,
    });
  }

  return { credentials, skippedRows, format };
}
