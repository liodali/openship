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

/** Origin CA validity bounds (Cloudflare API-supported range, in days). */
export const DISCOVERY_TLS_ORIGIN_CA_VALIDITY = {
  minDays: 7,
  maxDays: 3650,
  defaultDays: 365,
} as const;

/** Total validator for Origin CA validity-in-days. */
export function isValidOriginCaValidityDays(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= DISCOVERY_TLS_ORIGIN_CA_VALIDITY.minDays &&
    value <= DISCOVERY_TLS_ORIGIN_CA_VALIDITY.maxDays
  );
}
