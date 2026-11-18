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
  cloudflareFetch,
  cloudflareList,
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
  });
}

/** GET /certificates/{id} — the DECISIVE recovery read: returns the certificate
 *  PEM, whose public key can be compared against our pending private key. */
export function getOriginCaCertificate(apiToken: string, id: string): Promise<OriginCaCertificateSummary> {
  return cloudflareFetch<OriginCaCertificateSummary>(apiToken, `/certificates/${encodeURIComponent(id)}`);
}

/** GET /certificates — every certificate the token can see (zone-scoped tokens
 *  see only their zone's certificates — the credential scoping IS the boundary). */
export function listOriginCaCertificates(apiToken: string): Promise<OriginCaCertificateSummary[]> {
  return cloudflareList<OriginCaCertificateSummary>(apiToken, "/certificates");
}

/** DELETE /certificates/{id} — revocation. Only ever called for certificates
 *  proven exclusively managed here (plan §4), never for uploaded/adopted ones. */
export async function revokeOriginCaCertificate(apiToken: string, id: string): Promise<void> {
  await cloudflareRequest<unknown>(apiToken, `/certificates/${encodeURIComponent(id)}`, { method: "DELETE" });
}
