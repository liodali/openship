/**
 * Cloudflare Origin CA client (docs/cloudflare-origin-ca-discovery-plan.md §3):
 * create / get / list / revoke over the Origin CA Certificates API.
 *
 * Reuses the shared bounded transport (cloudflare-api.ts): 15s timeout, JSON
 * envelope validation, error redaction (the token is scrubbed from any detail;
 * CSRs and certificates are public material and are never embedded in errors).
 * Sent to Cloudflare: the CSR, the authorized hostname set, the request type,
 * and the requested validity — NEVER the private key (it exists only inside
 * Openship, encrypted at rest).
 *
 * Ambiguity contract: `createOriginCaCertificate` resolves ONLY on a definitive
 * API success or a definitive rejection. Timeout/5xx/network failures throw
 * CloudflareApiError — the CALLER must treat those as UNKNOWN outcomes and
 * recover through reads (list/get + CSR public-key match), never blind retries.
 */
import {
  CloudflareApiError,
  cloudflareFetch,
  cloudflareRequest,
} from "../../lib/cloudflare-api";
import type { OriginCaValidityDays } from "@repo/core";

export interface OriginCaCertificateSummary {
  id: string;
  /** The PEM certificate — PUBLIC material. */
  certificate?: string;
  hostnames?: string[];
  /** Cloudflare's "expires_on" (date). */
  expiresOn?: string;
  revokedAt?: string | null;
  createdAt?: string;
}

/** POST /certificates — CSR-based issuance. request_type origin-rsa for our RSA 2048 CSRs. */
export function createOriginCaCertificate(
  apiToken: string,
  input: { csrPem: string; hostnames: string[]; requestedValidityDays: OriginCaValidityDays },
): Promise<OriginCaCertificateSummary> {
  return cloudflareFetch<OriginCaCertificateSummary>(apiToken, "/certificates", {
    method: "POST",
    body: JSON.stringify({
      requested_validity: input.requestedValidityDays,
      request_type: "origin-rsa",
      csr: input.csrPem,
      hostnames: input.hostnames,
    }),
  }).then((raw) => normalizeOriginCaCertificate(raw as RawOriginCaCertificate));
}

/** GET /certificates/{id} — the DECISIVE recovery read: returns the certificate
 *  PEM, whose public key can be compared against our pending private key. */
export function getOriginCaCertificate(apiToken: string, id: string): Promise<OriginCaCertificateSummary> {
  return cloudflareFetch<OriginCaCertificateSummary>(apiToken, `/certificates/${encodeURIComponent(id)}`).then((raw) =>
    normalizeOriginCaCertificate(raw as RawOriginCaCertificate),
  );
}

/**
 * GET /certificates — the recovery sweep. The Origin CA list endpoint REQUIRES
 * a zone_id query parameter (the token's zone scope selects the certificates;
 * there is no account-wide listing) and allows at most 50 results per page, so
 * this drives its own pagination loop instead of the shared helper (which
 * assumes per_page=100). The persisted zoneId is passed — recovery must read
 * the SAME zone the certificate was requested from.
 */
export async function listOriginCaCertificates(apiToken: string, zoneId: string): Promise<OriginCaCertificateSummary[]> {
  const result: OriginCaCertificateSummary[] = [];
  for (let page = 1; page <= 50; page++) {
    const body = await cloudflareRequest<OriginCaCertificateSummary[]>(
      apiToken,
      `/certificates?zone_id=${encodeURIComponent(zoneId)}&per_page=50&page=${page}`,
    );
    if (!Array.isArray(body.result))
      throw new CloudflareApiError(502, "The API returned an invalid list.");
    result.push(...body.result.map((raw) => normalizeOriginCaCertificate(raw as RawOriginCaCertificate)));
    const fullPage = body.result.length >= 50;
    if (!fullPage || (body.result_info?.total_pages !== undefined && page >= body.result_info.total_pages)) {
      return result;
    }
  }
  throw new CloudflareApiError(
    502,
    "Too many results. Use a token scoped to the required zone.",
  );
}

/** DELETE /certificates/{id} — revocation. Only ever called for certificates
 *  proven exclusively managed here (plan §4), never for uploaded/adopted ones. */
export async function revokeOriginCaCertificate(apiToken: string, id: string): Promise<void> {
  await cloudflareRequest<unknown>(apiToken, `/certificates/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// ── Response normalization ───────────────────────────────────────────────
// The Origin CA API answers in snake_case (expires_on, revoked_at, created_on);
// everything downstream of this module reads camelCase. Normalizing HERE means
// callers cannot accidentally read a field the API never set (e.g. filtering
// on revokedAt when the wire says revoked_at — which silently matches nothing).

/** Raw response shape, as the wire returns it. */
export interface RawOriginCaCertificate {
  id?: unknown;
  certificate?: unknown;
  hostnames?: unknown;
  expires_on?: unknown;
  expiresOn?: unknown;
  revoked_at?: unknown;
  revokedAt?: unknown;
  created_on?: unknown;
  createdAt?: unknown;
  [key: string]: unknown;
}

function asIsoDate(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "string") return null;
  return value;
}

export function normalizeOriginCaCertificate(raw: RawOriginCaCertificate): OriginCaCertificateSummary {
  return {
    id: typeof raw.id === "string" ? raw.id : "",
    certificate: typeof raw.certificate === "string" ? raw.certificate : undefined,
    hostnames: Array.isArray(raw.hostnames) ? raw.hostnames.filter((h): h is string => typeof h === "string") : undefined,
    expiresOn: asIsoDate(raw.expires_on ?? raw.expiresOn) ?? undefined,
    revokedAt: asIsoDate(raw.revoked_at ?? raw.revokedAt) ?? undefined,
    createdAt: asIsoDate(raw.created_on ?? raw.createdAt) ?? undefined,
  };
}
