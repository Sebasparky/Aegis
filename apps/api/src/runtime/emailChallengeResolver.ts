import type { SecurityChallenge, ChallengeEmailSearchErrorCode } from "@aegis/types";

/**
 * Memory-only store for resolved verification codes.
 * Key: resolution_id. Value: { code, expires_at }.
 * Never persisted to disk. Never logged. Never returned to the agent.
 * Deleted immediately after injection attempt (success or failure).
 */
export const resolutionCodes = new Map<string, { code: string; expires_at: string }>();

// ---------------------------------------------------------------------------
// Provider policy registry
// ---------------------------------------------------------------------------

interface VerificationEmailPolicy {
  challenge_domain: string;
  /** Gmail "from:" search terms — joined with OR to build the query */
  sender_emails: string[];
  /** Per-message sender domain allowlist — checked against the From header */
  allowed_sender_domains: Set<string>;
}

const VERIFICATION_EMAIL_POLICIES: VerificationEmailPolicy[] = [
  {
    challenge_domain: "github.com",
    sender_emails: ["noreply@github.com", "github-noreply@github.com"],
    allowed_sender_domains: new Set(["github.com"]),
  },
  // Future providers: google.com, microsoft.com, supabase.com, vercel.com, etc.
];

/** Returns true if the given challenge domain has a registered email verification policy. */
export function isEmailChallengeSupported(domain: string): boolean {
  return VERIFICATION_EMAIL_POLICIES.some(p => p.challenge_domain === domain);
}

function getEmailPolicyForDomain(domain: string): VerificationEmailPolicy | null {
  return VERIFICATION_EMAIL_POLICIES.find(p => p.challenge_domain === domain) ?? null;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmailResolverStatus {
  connected: boolean;
  method: "env_var" | "none";
}

export interface GmailSearchResult {
  code: string;
  sender_domain: string;
  received_at: string;
  /** Safe metadata describing which phase found the code — never contains the code or email text. */
  extraction_source: "subject_snippet" | "body_text";
}

type GmailMessagePart = {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailMessagePart[];
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_BODY_CHARS = 20_000;
const MAX_BODY_FETCHES = 2;

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

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
 * Classify a Gmail search failure into a stable error code and user-safe message.
 * Raw OAuth error details are never surfaced to the user.
 */
export function classifyGmailError(err: unknown): {
  email_search_error_code: ChallengeEmailSearchErrorCode;
  user_message: string;
} {
  const msg = err instanceof Error ? err.message : "";
  if (msg.startsWith("GMAIL_TOKEN_REFRESH_FAILED")) {
    return {
      email_search_error_code: "GMAIL_RECONNECT_REQUIRED",
      user_message: "Your Gmail connection expired or was revoked.",
    };
  }
  return {
    email_search_error_code: "GMAIL_SEARCH_UNAVAILABLE",
    user_message: "Gmail search is currently unavailable.",
  };
}

/**
 * Extract a verification code from a text string.
 * Matches standalone 6-8 digit codes (most services use 6 digits).
 * Text is internal-only — never logged or returned.
 *
 * TODO(v2): context-aware extraction — prioritize codes near keywords:
 *   "code", "verify", "verification", "authentication", "security", "sign in", "login", "device"
 */
export function extractVerificationCode(text: string): string | null {
  const pattern = /\b(\d{6}|\d{8})\b/;
  const match = pattern.exec(text);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Extract hostname from a "From" header value like "GitHub <noreply@github.com>"
 * Returns the domain only, never the full sender name or email.
 */
function extractSenderDomain(fromHeader: string): string | null {
  const match = fromHeader.match(/<([^>]+)>/) ?? fromHeader.match(/(\S+@\S+)/);
  if (!match) return null;
  const email = match[1].trim();
  const atIdx = email.indexOf("@");
  if (atIdx === -1) return null;
  return email.slice(atIdx + 1).toLowerCase();
}

/**
 * Recursively extract plain text from a Gmail MIME payload.
 * Prefers text/plain; falls back to tag-stripped text/html.
 * Returns at most MAX_BODY_CHARS characters.
 * Result is function-local — never stored, logged, or returned outside searchGmailForChallengeCode.
 */
function extractBodyText(payload: GmailMessagePart): string | null {
  function findText(part: GmailMessagePart, mimeType: string): string | null {
    if (part.mimeType === mimeType && part.body?.data) {
      return Buffer.from(part.body.data, "base64").toString("utf-8").slice(0, MAX_BODY_CHARS);
    }
    for (const child of part.parts ?? []) {
      const result = findText(child, mimeType);
      if (result) return result;
    }
    return null;
  }

  const plain = findText(payload, "text/plain");
  if (plain) return plain;

  const html = findText(payload, "text/html");
  if (html) {
    return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_BODY_CHARS);
  }

  return null;
}

/**
 * Fetch a single Gmail message body using format=FULL.
 * Returns only the decoded text content — never the raw API payload, headers, or message ID.
 * Body text is returned as a plain string and must be treated as function-local by the caller.
 * Returns null on any fetch error or if no text content is found.
 */
async function fetchMessageBody(messageId: string, accessToken: string): Promise<string | null> {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=FULL`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return null;

  const data = await res.json() as { payload?: GmailMessagePart };
  // data (full API response with headers, labels, raw payload tree) goes out of scope here.
  // Only the extracted text string is returned.
  return data.payload ? extractBodyText(data.payload) : null;
}

// ---------------------------------------------------------------------------
// Main search function
// ---------------------------------------------------------------------------

// 5-minute buffer for legitimate clock skew between mail servers and the local clock.
const CLOCK_SKEW_BUFFER_MS = 5 * 60 * 1000;

/**
 * Search Gmail for a recent verification email matching the given challenge.
 *
 * Multiple verification emails may exist — the user may have triggered login more than
 * once, and each attempt produces a new email. Only the newest code matches the current
 * challenge; older codes are already expired or invalid. We therefore collect all valid
 * candidates, sort by received_at descending, and try the newest first.
 *
 * Three-phase approach:
 *   Phase 1 — metadata collection: fetch up to 5 messages with format=METADATA; validate
 *     sender domain and received time window; collect all passing candidates with their
 *     subject and snippet for extraction. Do not rely on Gmail API result ordering.
 *   Phase 2 — subject/snippet extraction: iterate candidates newest-first and try
 *     extractVerificationCode on subject + snippet. Return on first success.
 *   Phase 3 — restricted body fetch: if Phase 2 found nothing, fetch body for the top
 *     MAX_BODY_FETCHES candidates (newest-first). Body text is function-local — never
 *     stored, logged, or returned.
 *
 * Safety invariants:
 * - Subject, snippet, and body text are never logged or returned
 * - Sender domain validated per-result against policy.allowed_sender_domains
 * - Only messages in the window [challenge.created_at - 2 min, now + CLOCK_SKEW_BUFFER] are considered
 * - Candidates sorted newest-first before extraction — oldest codes are never tried before newest
 * - Returns null (not_found) if no code found; never throws on search miss
 */
export async function searchGmailForChallengeCode(
  challenge: SecurityChallenge,
): Promise<GmailSearchResult | null> {
  const policy = getEmailPolicyForDomain(challenge.domain);
  if (!policy) return null;

  const accessToken = await refreshGmailAccessToken();

  const fromTerms = policy.sender_emails.join(" OR ");
  const query = `from:(${fromTerms}) newer_than:10m`;
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

  // Allow emails received up to 2 minutes before the challenge was created.
  // The service sends the email at login time; the agent reports the challenge a few seconds
  // later, so the email's Date header can be slightly older than challenge.created_at.
  const windowStart = new Date(challenge.created_at).getTime() - 2 * 60 * 1000;
  // Reject emails with implausible future dates — guards against clock skew between mail servers.
  const windowEnd = Date.now() + CLOCK_SKEW_BUFFER_MS;

  // subject and snippet are stored transiently for extraction only — never logged or returned.
  type Candidate = { id: string; sender_domain: string; received_at: Date; subject: string; snippet: string };
  const candidates: Candidate[] = [];

  // Phase 1: metadata collection — validate each message and collect passing candidates
  for (const msg of messages) {
    // metadataHeaders must be repeated params — comma-joined is treated as one header name
    // and returns 0 matching headers, which breaks sender/date checks.
    const msgParams = new URLSearchParams({ format: "METADATA" });
    msgParams.append("metadataHeaders", "Subject");
    msgParams.append("metadataHeaders", "From");
    msgParams.append("metadataHeaders", "Date");
    const msgUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(msg.id)}?${msgParams}`;

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

    // Validate sender domain against policy allowlist
    const senderDomain = extractSenderDomain(fromHeader);
    if (!senderDomain || !policy.allowed_sender_domains.has(senderDomain)) continue;

    // Validate received time: must fall within [windowStart, windowEnd]
    const receivedAt = new Date(dateHeader);
    if (isNaN(receivedAt.getTime())) continue;
    if (receivedAt.getTime() < windowStart) continue;
    if (receivedAt.getTime() > windowEnd) continue;

    candidates.push({ id: msg.id, sender_domain: senderDomain, received_at: receivedAt, subject: subjectHeader, snippet });
  }

  // Sort newest-first — do not rely on Gmail API result ordering.
  // If the user triggered login multiple times, only the newest code is valid.
  candidates.sort((a, b) => b.received_at.getTime() - a.received_at.getTime());

  // Phase 2: subject + snippet extraction — try newest candidate first
  for (const candidate of candidates) {
    // subject and snippet are never logged or returned
    const code = extractVerificationCode(candidate.subject + " " + candidate.snippet);
    if (code) {
      return {
        code,
        sender_domain: candidate.sender_domain,
        received_at: candidate.received_at.toISOString(),
        extraction_source: "subject_snippet",
      };
    }
  }

  // Phase 3: restricted body fetch — top MAX_BODY_FETCHES candidates, newest-first
  let bodyFetchCount = 0;
  for (const candidate of candidates) {
    if (bodyFetchCount >= MAX_BODY_FETCHES) break;
    bodyFetchCount++;
    const bodyText = await fetchMessageBody(candidate.id, accessToken);
    if (bodyText) {
      const code = extractVerificationCode(bodyText);
      // bodyText goes out of scope here — never stored, never returned
      if (code) {
        return {
          code,
          sender_domain: candidate.sender_domain,
          received_at: candidate.received_at.toISOString(),
          extraction_source: "body_text",
        };
      }
    }
  }

  return null;
}
