/**
 * Docker service discovery — managed TLS provider identity
 * (docs/cloudflare-origin-ca-discovery-plan.md).
 *
 * Discovery supports EXACTLY TWO managed TLS selections. The IDs are the
 * canonical vocabulary shared by the parser (labels/env), contracts (wire
 * schemas), persistence (schema column types), and the TLS dispatch. Nothing
 * else may mint a third value, and `sslIssuer` is never a substitute: it
 * describes an installed certificate, not operator intent.
 *
 * Pure by design: constants and total validators only — no I/O, no clock.
 */

/**
 * The two managed provider IDs.
 *  - `letsencrypt`: the existing ACME flow (HTTP-01 / configured DNS-01).
 *  - `cloudflare-origin-ca`: Cloudflare Origin CA certificates, trusted by
 *    Cloudflare's edge (proxied hostname + Full (strict)), never by browsers
 *    connecting directly. Requires a per-domain credential and zone.
 */
export const DISCOVERY_TLS_PROVIDERS = ["letsencrypt", "cloudflare-origin-ca"] as const;
export type DiscoveryTlsProvider = (typeof DISCOVERY_TLS_PROVIDERS)[number];

/** The initial server default. Applies to NEWLY enrolled domains only. */
export const DISCOVERY_TLS_DEFAULT_PROVIDER: DiscoveryTlsProvider = "letsencrypt";

/** Total, allocation-free membership check — the single source of truth. */
export function isDiscoveryTlsProvider(value: unknown): value is DiscoveryTlsProvider {
  return value === "letsencrypt" || value === "cloudflare-origin-ca";
}

/**
 * How a domain's persisted provider was chosen:
 *  - `default`: resolved from the server default at enrollment; a later server
 *    default change never rewrites it.
 *  - `explicit`: an operator (or, later, an agreeing label) set it for THIS
 *    domain; overrides the default and survives everything but an explicit
 *    policy change.
 */
export const DISCOVERY_TLS_PROVIDER_SOURCES = ["default", "explicit"] as const;
export type DiscoveryTlsProviderSource = (typeof DISCOVERY_TLS_PROVIDER_SOURCES)[number];

/**
 * Origin CA validity — Cloudflare's DISCRETE supported durations, in days
 * (https://developers.cloudflare.com/api/resources/origin_ca_certificates/methods/create/).
 * Not a free integer range: 8 or 3650 days are rejected by the API just like
 * an out-of-bounds value, while 5475 days (15 years) is supported.
 */
export const DISCOVERY_TLS_ORIGIN_CA_VALIDITY_DAYS = [7, 30, 90, 365, 730, 1095, 5475] as const;
export type OriginCaValidityDays = (typeof DISCOVERY_TLS_ORIGIN_CA_VALIDITY_DAYS)[number];

/** The provider default when a policy requests none. */
export const DISCOVERY_TLS_ORIGIN_CA_DEFAULT_VALIDITY_DAYS: OriginCaValidityDays = 365;

/** Total validator: ONLY Cloudflare's discrete supported values. */
export function isSupportedOriginCaValidityDays(value: unknown): value is OriginCaValidityDays {
  return (
    typeof value === "number" &&
    (DISCOVERY_TLS_ORIGIN_CA_VALIDITY_DAYS as readonly unknown[]).includes(value)
  );
}
