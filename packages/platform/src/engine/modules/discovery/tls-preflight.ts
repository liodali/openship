/**
 * Cloudflare Origin CA preflight (docs/cloudflare-origin-ca-discovery-plan.md §2).
 *
 * READ-ONLY checks against the Cloudflare API, run BEFORE a domain's Cloudflare
 * configuration is accepted or any issuance is dispatched:
 *  1. The zone exists, is active, and the credential can read it (Zone Read).
 *  2. The hostname sits inside the zone by a DNS-LABEL boundary — a sibling
 *     suffix (`evilexample.com` vs `example.com`) is rejected; reusing a
 *     credential for one domain authorizes nothing else.
 *  3. An effective proxied hostname: exact proxied records, or a proxied
 *     wildcard DNS record at an ancestor level (proxied wildcard DNS does NOT
 *     enable wildcard certificates — it only proves traffic rides Cloudflare).
 *  4. Full (strict): the zone SSL mode must be `strict`. `full` is NOT
 *     Full (strict) and is refused.
 *  5. Configuration-rule overrides: a ruleset override touching SSL settings
 *     makes the EFFECTIVE mode unprovable from the zone default — reported
 *     unresolved (refused), never claimed as proven.
 *
 * Everything here is read-only: a throwaway certificate is never issued merely
 * to test a credential (plan). Any failure throws BEFORE the policy write, so
 * the previous desired/active policy and the working certificate are intact.
 * API outages surface as CloudflareApiError (502, retryable) — visible retry
 * states, not certificate failures.
 */
import { AppError } from "@repo/core";
import { CloudflareApiError, cloudflareFetch, cloudflareList } from "../../lib/cloudflare-api";

export class TlsConfigurationUnresolvedError extends AppError {
  constructor(message: string) {
    super(message, 409, "TLS_CONFIGURATION_UNRESOLVED");
  }
}

interface CloudflareZone {
  id: string;
  name: string;
  status: string;
}

interface CloudflareDnsRecord {
  name: string;
  type: string;
  proxied: boolean | null;
}

/** True when `hostname` sits inside `zoneName` by a complete DNS-label boundary. */
export function hostnameInZone(hostname: string, zoneName: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const zone = zoneName.toLowerCase().replace(/\.$/, "");
  return host === zone || host.endsWith(`.${zone}`);
}

/** The wildcard DNS names that could cover `hostname`, nearest ancestor first
 *  (`a.b.example.com` → `*.b.example.com`, `*.example.com`). */
export function wildcardCandidates(hostname: string): string[] {
  const labels = hostname.toLowerCase().replace(/\.$/, "").split(".");
  const out: string[] = [];
  // Stop before consuming the last two labels: a TLD is not a zone apex.
  for (let i = 1; i <= labels.length - 2; i++) {
    out.push(`*.${labels.slice(i).join(".")}`);
  }
  return out;
}

/**
 * Run every preflight read for one hostname/zone pair. Returns the VERIFIED
 * zone name (never trust a submitted name — the zone's own record is the
 * truth). Throws the stable TLS_* codes above for configuration refusals and
 * CloudflareApiError for provider outages (retryable, nothing persisted).
 */
export async function preflightCloudflareOriginCa(input: {
  apiToken: string;
  zoneId: string;
  hostname: string;
}): Promise<{ zoneName: string }> {
  const hostname = input.hostname.toLowerCase().replace(/\.$/, "");

  // 1. The zone, through THIS credential: existence, active status, and the
  //    credential's Zone Read in one request. A 403 here is a credential
  //    permission failure — surfaced as CloudflareApiError, blocking new
  //    issuance without touching the working certificate.
  const zone = await cloudflareFetch<CloudflareZone>(input.apiToken, `/zones/${encodeURIComponent(input.zoneId)}`);
  if (!zone?.name || typeof zone.name !== "string") {
    throw new TlsConfigurationUnresolvedError(
      `Cloudflare zone ${input.zoneId} could not be resolved for ${hostname}; the credential may lack Zone Read permission.`,
    );
  }
  if (zone.status !== "active") {
    throw new TlsConfigurationUnresolvedError(
      `Cloudflare zone ${zone.name} is "${zone.status}", not active; Origin CA issuance waits for an active zone.`,
    );
  }

  // 2. Membership by DNS-label boundary in the CONFIGURED zone.
  if (!hostnameInZone(hostname, zone.name)) {
    throw new AppError(
      `${hostname} is not within the configured Cloudflare zone ${zone.name}; point this domain's policy at the zone that actually contains it.`,
      409,
      "TLS_ZONE_MEMBERSHIP_INVALID",
    );
  }

  // 3. Effective proxied hostname: exact records first, then wildcard records
  //    at ancestor levels (a proxied wildcard DNS record proves the hostname's
  //    traffic rides Cloudflare without enabling any wildcard certificate).
  const isAddressRecord = (record: CloudflareDnsRecord) =>
    record.type === "A" || record.type === "AAAA" || record.type === "CNAME";
  let proxied = false;
  try {
    const exact = await cloudflareList<CloudflareDnsRecord>(
      input.apiToken,
      `/zones/${encodeURIComponent(input.zoneId)}/dns_records?name=${encodeURIComponent(hostname)}`,
    );
    proxied = exact.some((record) => isAddressRecord(record) && record.proxied === true);
    if (!proxied) {
      for (const candidate of wildcardCandidates(hostname)) {
        const wildcardRecords = await cloudflareList<CloudflareDnsRecord>(
          input.apiToken,
          `/zones/${encodeURIComponent(input.zoneId)}/dns_records?name=${encodeURIComponent(candidate)}`,
        );
        if (wildcardRecords.some((record) => isAddressRecord(record) && record.proxied === true)) {
          proxied = true;
          break;
        }
      }
    }
  } catch (error) {
    // Unreadable DNS state is not evidence of proxying: refuse (retryable),
    // never assume. The working certificate is untouched.
    if (error instanceof AppError) throw error;
    throw new TlsConfigurationUnresolvedError(
      `Cloudflare DNS records for ${hostname} could not be read; proxy status is unproven.`,
    );
  }
  if (!proxied) {
    throw new AppError(
      `${hostname} has no proxied Cloudflare DNS record. Origin CA certificates are trusted by Cloudflare's edge only: proxy the hostname (orange cloud) before selecting this provider.`,
      409,
      "TLS_DNS_NOT_PROXIED",
    );
  }

  // 4. Full (strict) — the zone's SSL mode. `full` encrypts origin traffic but
  //    does NOT validate the certificate and is refused; only `strict` is.
  const ssl = await cloudflareFetch<{ value: string }>(
    input.apiToken,
    `/zones/${encodeURIComponent(input.zoneId)}/settings/ssl`,
  );
  const sslMode = typeof ssl?.value === "string" ? ssl.value : "";
  if (sslMode !== "strict") {
    throw new AppError(
      `Cloudflare zone ${zone.name} uses SSL mode "${sslMode || "unknown"}"; Origin CA requires Full (strict). Set the zone's SSL/TLS mode to Full (strict) — Openship never changes zone settings.`,
      409,
      "TLS_SSL_MODE_UNSUPPORTED",
    );
  }

  // 5. Configuration-rule overrides: a ruleset in the http_config_settings
  //    phase touching SSL settings would change the EFFECTIVE mode per-host
  //    while the zone default still reads "strict". First release supports
  //    only provable configurations: such an override is unresolved (refused),
  //    never claimed as proven. A 404 means no entrypoint ruleset exists —
  //    the zone default IS the effective mode.
  try {
    const ruleset = await cloudflareFetch<{ rules?: Array<{ action_parameters?: Record<string, unknown> }> }>(
      input.apiToken,
      `/zones/${encodeURIComponent(input.zoneId)}/rulesets/phases/http_config_settings/entrypoint`,
    );
    const overridesSsl = (ruleset?.rules ?? []).some((rule) =>
      Object.prototype.hasOwnProperty.call(rule.action_parameters ?? {}, "ssl"),
    );
    if (overridesSsl) {
      throw new TlsConfigurationUnresolvedError(
        `Cloudflare zone ${zone.name} has configuration rules overriding SSL settings; the effective mode for ${hostname} cannot be proven from the zone default. Resolve the rules or scope them away from this hostname first.`,
      );
    }
  } catch (error) {
    if (error instanceof TlsConfigurationUnresolvedError) throw error;
    if (error instanceof CloudflareApiError && error.providerStatus === 404) {
      // No configuration rules: the zone default IS the effective mode.
    } else {
      // Unreadable rulesets = unproven effective mode: refuse (retryable).
      throw new TlsConfigurationUnresolvedError(
        `Cloudflare configuration rules for zone ${zone.name} could not be read; the effective SSL mode for ${hostname} is unproven.`,
      );
    }
  }

  return { zoneName: zone.name };
}
