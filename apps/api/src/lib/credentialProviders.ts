// TODO: move this registry to a shared package (e.g. @aegis/credential-providers) once one exists
import type { CredentialProviderDefinition, CredentialProviderMatch } from "@aegis/types";

const PROVIDER_REGISTRY: CredentialProviderDefinition[] = [
  { provider_id: "github", display_name: "GitHub", login_domains: ["github.com"], oauth_provider: true },
  {
    provider_id: "google",
    display_name: "Google",
    login_domains: ["accounts.google.com", "google.com"],
    oauth_provider: true,
  },
  {
    provider_id: "microsoft",
    display_name: "Microsoft",
    login_domains: ["login.microsoftonline.com", "live.com", "microsoft.com"],
    oauth_provider: true,
  },
  { provider_id: "apple", display_name: "Apple", login_domains: ["appleid.apple.com"], oauth_provider: true },
  { provider_id: "supabase", display_name: "Supabase", login_domains: ["supabase.com"], oauth_provider: false },
  { provider_id: "vercel", display_name: "Vercel", login_domains: ["vercel.com"], oauth_provider: false },
  {
    provider_id: "aws",
    display_name: "AWS",
    login_domains: ["signin.aws.amazon.com", "aws.amazon.com"],
    oauth_provider: false,
  },
  {
    provider_id: "stripe",
    display_name: "Stripe",
    login_domains: ["dashboard.stripe.com", "stripe.com"],
    oauth_provider: false,
  },
  { provider_id: "slack", display_name: "Slack", login_domains: ["slack.com"], oauth_provider: false },
  { provider_id: "discord", display_name: "Discord", login_domains: ["discord.com"], oauth_provider: false },
  { provider_id: "notion", display_name: "Notion", login_domains: ["notion.so"], oauth_provider: false },
  { provider_id: "linear", display_name: "Linear", login_domains: ["linear.app"], oauth_provider: false },
  { provider_id: "figma", display_name: "Figma", login_domains: ["figma.com"], oauth_provider: false },
];

// Accepts "github.com", "https://github.com/login", "https://www.github.com/session"
// Returns normalized hostname without protocol, path, port, or leading www.
export function normalizeLoginDomain(input: string): string {
  let d = input.trim();
  d = d.replace(/^https?:\/\//i, "");
  d = d.split("/")[0];
  d = d.split(":")[0];
  d = d.replace(/^www\./i, "");
  return d.toLowerCase();
}

// Returns the first provider whose login_domains contains the normalized input (exact or subdomain match).
// This is a display-only lookup — it does NOT grant injection rights on any domain.
// Injection domain validation remains enforced by the existing pass.domain check in the CDP fill endpoint.
export function findCredentialProviderByDomain(domainOrUrl: string): CredentialProviderMatch | null {
  const normalized = normalizeLoginDomain(domainOrUrl);
  for (const p of PROVIDER_REGISTRY) {
    for (const loginDomain of p.login_domains) {
      if (normalized === loginDomain || normalized.endsWith(`.${loginDomain}`)) {
        return {
          provider_id: p.provider_id,
          display_name: p.display_name,
          matched_domain: loginDomain,
          login_domains: p.login_domains,
          oauth_provider: p.oauth_provider,
          is_custom: false,
        };
      }
    }
  }
  return null;
}

// Returns a display label for a vault pass, inferring provider from domain.
// Format: "GitHub · username" | "Custom · username" | "domain · username"
// Does not require schema migration — infers from pass.domain only.
export function getCredentialDisplayLabel(pass: {
  domain: string;
  username?: string;
  label: string;
}): string {
  const provider = findCredentialProviderByDomain(pass.domain);
  const prefix = provider ? provider.display_name : pass.domain;
  const suffix = pass.username ?? pass.label;
  return `${prefix} · ${suffix}`;
}

// Returns approval UI safety copy for credential injection.
// When requesting_site differs from the injection domain, it clarifies the three-domain distinction
// to prevent the user from thinking the credential will be used on the requesting site.
export function getInjectionSafetyCopy(opts: {
  requesting_site?: string;
  provider_display_name: string;
  injection_domain: string;
}): string {
  const { requesting_site, provider_display_name, injection_domain } = opts;
  if (requesting_site && requesting_site !== injection_domain) {
    return `${requesting_site} is asking you to sign in with ${provider_display_name}. Aegis will only inject this credential on ${injection_domain}.`;
  }
  return `Aegis will only inject this credential on ${injection_domain}.`;
}
