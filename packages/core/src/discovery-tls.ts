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
 * Stable error code for a disagreement between a container's TLS declaration
 * (openship.tls.provider / OPENSHIP_TLS_PROVIDER) and the domain's EXPLICIT
 * per-domain policy. A conflict never changes working certificate material and
 * never blocks routing: the declaration is refused until the operator updates
 * or removes it (or the policy), and periodic scans never undo a UI choice.
 */
export const DISCOVERY_TLS_POLICY_CONFLICT = "tls-policy-conflict";

/**
 * DURABLE provenance of an explicit managed TLS policy — who made the choice
 * that is currently persisted. Internal persistence vocabulary, not a wire
 * field: the published `selectionSource` stays `default | explicit`.
 *  - `admin`: an operator wrote it through the API/UI policy path. Only another
 *    admin write may change it; a disagreeing container declaration conflicts.
 *  - `declaration`: a container declaration wrote it. A newer declaration may
 *    evolve it (labels are an explicit selection path).
 * Provenance is RECORDED, never inferred from value agreement: an admin
 * credential/zone configuration under a declared provider still transfers
 * ownership to the admin, so a later label change cannot silently replace an
 * admin-selected policy (or clear its credentials).
 */
export const DISCOVERY_TLS_POLICY_ORIGINS = ["admin", "declaration"] as const;
export type DiscoveryTlsPolicyOrigin = (typeof DISCOVERY_TLS_POLICY_ORIGINS)[number];

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
