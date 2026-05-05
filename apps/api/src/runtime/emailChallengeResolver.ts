import type { SecurityChallenge } from "@aegis/types";

/**
 * Memory-only store for resolved verification codes.
 * Key: resolution_id. Value: { code, expires_at }.
 * Never persisted to disk. Never logged. Never returned to the agent.
 * Deleted immediately after injection attempt (success or failure).
 */
export const resolutionCodes = new Map<string, { code: string; expires_at: string }>();

// Allowlisted GitHub sender domains for verification emails
const GITHUB_SENDER_DOMAINS = new Set(["github.com"]);
// Allowlisted GitHub sender addresses (matched by domain extraction)
const GITHUB_SENDER_HOSTNAMES = new Set(["github.com"]);

export interface EmailResolverStatus {
  connected: boolean;
  method: "env_var" | "none";
}

/**
 * Returns connection status based on env var presence.
 * No OAuth tokens are stored in Maps or persistence in v1.
 */
export function getEmailResolverStatus(): EmailResolverStatus {
  const hasToken = !!(
    process.env.GOOGLE_REFRESH_TOKEN &&
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET
  );
  return {
    connected: hasToken,
    method: hasToken ? "env_var" : "none",
  };
}

/**
 * Exchange refresh token for a short-lived access token.
 * Reads GOOGLE_REFRESH_TOKEN, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET from process.env only.
 * Never stores the access token or refresh token in Maps.
 */
export async function refreshGmailAccessToken(): Promise<string> {
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!refreshToken || !clientId || !clientSecret) {
    throw new Error("GMAIL_NOT_CONFIGURED: GOOGLE_REFRESH_TOKEN, GOOGLE_CLIENT_ID, and GOOGLE_CLIENT_SECRET must be set.");
  }

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GMAIL_TOKEN_REFRESH_FAILED: ${res.status} ${body}`);
  }

  const data = await res.json() as { access_token?: string };
  if (!data.access_token) {
    throw new Error("GMAIL_TOKEN_REFRESH_FAILED: No access_token in response.");
  }

  return data.access_token;
}

/**
 * Extract a verification code from email subject and snippet.
 * Tries subject first, then snippet. Uses digits-only 6-8 char regex.
 * Subject and snippet are internal-only — never logged or returned.
 */
export function extractVerificationCode(subject: string, snippet: string): string | null {
  // Match standalone 6-8 digit codes (most common for GitHub: 6 digits)
  const pattern = /\b(\d{6}|\d{8})\b/;

  const subjectMatch = pattern.exec(subject);
  if (subjectMatch) return subjectMatch[1];

  const snippetMatch = pattern.exec(snippet);
  if (snippetMatch) return snippetMatch[1];

  return null;
}

/**
 * Extract hostname from a "From" header value like "GitHub <noreply@github.com>"
 * Returns the domain only, never the full sender name or email.
 */
function extractSenderDomain(fromHeader: string): string | null {
  // Match email address within angle brackets or bare
  const match = fromHeader.match(/<([^>]+)>/) ?? fromHeader.match(/(\S+@\S+)/);
  if (!match) return null;
  const email = match[1].trim();
  const atIdx = email.indexOf("@");
  if (atIdx === -1) return null;
  return email.slice(atIdx + 1).toLowerCase();
}

export interface GmailSearchResult {
  code: string;
  sender_domain: string;
  received_at: string;
}

/**
 * Search Gmail for a recent GitHub verification email matching the given challenge.
 *
 * Safety invariants:
 * - format=METADATA only — full body never fetched
 * - Subject and snippet used internally only — never logged or returned
 * - Sender domain validated per-result
 * - Only messages received after challenge.created_at are considered
 * - Returns null (not_found) if no code found; never throws on search miss
 */
export async function searchGmailForChallengeCode(
  challenge: SecurityChallenge,
): Promise<GmailSearchResult | null> {
  const accessToken = await refreshGmailAccessToken();

  const query = "from:(noreply@github.com OR github-noreply@github.com) newer_than:10m";
  const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?${new URLSearchParams({
    q: query,
    maxResults: "5",
  })}`;

  const listRes = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!listRes.ok) {
    const body = await listRes.text().catch(() => "");
    throw new Error(`GMAIL_SEARCH_FAILED: ${listRes.status} ${body}`);
  }

  const listData = await listRes.json() as { messages?: Array<{ id: string }> };
  const messages = listData.messages ?? [];

  const challengeCreatedAt = new Date(challenge.created_at).getTime();

  for (const msg of messages) {
    const msgUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(msg.id)}?${new URLSearchParams({
      format: "METADATA",
      metadataHeaders: ["Subject", "From", "Date"].join(","),
    })}`;

    const msgRes = await fetch(msgUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!msgRes.ok) continue;

    const msgData = await msgRes.json() as {
      snippet?: string;
      payload?: {
        headers?: Array<{ name: string; value: string }>;
      };
    };

    const headers = msgData.payload?.headers ?? [];
    const getHeader = (name: string) =>
      headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

    const fromHeader = getHeader("From");
    const dateHeader = getHeader("Date");
    const subjectHeader = getHeader("Subject");
    const snippet = msgData.snippet ?? "";

    // Validate sender domain
    const senderDomain = extractSenderDomain(fromHeader);
    if (!senderDomain || !GITHUB_SENDER_HOSTNAMES.has(senderDomain)) continue;

    // Filter: only emails received after the challenge was created
    const receivedAt = new Date(dateHeader);
    if (isNaN(receivedAt.getTime()) || receivedAt.getTime() < challengeCreatedAt) continue;

    // Extract code from subject then snippet — never log these values
    const code = extractVerificationCode(subjectHeader, snippet);
    if (!code) continue;

    return {
      code,
      sender_domain: senderDomain,
      received_at: receivedAt.toISOString(),
    };
  }

  return null;
}
