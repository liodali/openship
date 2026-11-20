/**
 * Origin CA resumable issuance orchestration (docs/cloudflare-origin-ca-
 * discovery-plan.md §3). The operation lifecycle, in order:
 *
 *  1. REUSE: a healthy matching ACTIVE certificate (domain inventory:
 *     tlsCertificateId/fingerprint recorded at activation) is reused without
 *     another create request.
 *  2. RESUME: a live issuance row (pending_create/candidate) is recovered —
 *     NEVER by blindly re-creating. Recovery reads the provider (list + get)
 *     and matches by hostname set AND CSR public key; the get is decisive
 *     (the certificate PEM's public key must pair with our pending key).
 *     Inconclusive recovery keeps the visible pending/unknown state and
 *     records a bounded attempt — it does not create repeatedly.
 *  3. FRESH: generate key + CSR locally, persist the encrypted intent BEFORE
 *     the create request, then create. A definitive success is validated
 *     (hostname, key match, expiry, issuer structure) before the candidate is
 *     stored; an AMBIGUOUS failure (timeout/5xx — the request may have
 *     landed) is NOT retried from here: the row stays pending_create and the
 *     NEXT attempt takes the recovery path.
 *
 * Private key handling: generated locally, sealed (enc1:) at this boundary,
 * persisted only in discovery_tls_issuance.key_enc — never returned, logged,
 * or embedded in errors.
 */
import { AppError } from "@repo/core";
import { repos } from "@repo/db";
import { decryptSecretField, encryptSecretField } from "../../lib/credential-encryption";
import { reportCaughtError } from "@repo/core/diagnostics";
import { CloudflareApiError } from "../../lib/cloudflare-api";
import { buildOriginCaCsr, csrToPem, generateOriginCaKey } from "./origin-ca-csr";
import {
  createOriginCaCertificate,
  getOriginCaCertificate,
  listOriginCaCertificates,
  type OriginCaCertificateSummary,
} from "./origin-ca-client";
import { validateOriginCaCertificate } from "./origin-ca-cert";
import { DISCOVERY_TLS_ORIGIN_CA_DEFAULT_VALIDITY_DAYS } from "@repo/core";
import { createPublicKey } from "node:crypto";
import { SYSTEM, type OriginCaValidityDays } from "@repo/core";

/** Bounded recovery attempts before a pending_create becomes a visible failure. */
const MAX_RECOVERY_ATTEMPTS = 5;
/** After the conclusive-attempt budget is exhausted, recovery READS continue
 *  on a slow cadence (the intent still blocks creation) — a certificate that
 *  only surfaced at the provider later must remain adoptable. */
const RECOVERY_RECHECK_INTERVAL_MS = 30 * 60_000;

export interface OriginCaIssuanceInput {
  /** The serving edge — scopes shared wildcard identity (plan: a child may
   *  only reference a shared certificate authorized for ITS server). */
  serverId?: string;
  domainId: string;
  operationId: string | null;
  hostname: string;
  zoneId: string;
  apiToken: string;
  organizationId: string;
  /** One of Cloudflare's discrete durations (validated at policy-write time). */
  validityDays?: OriginCaValidityDays;
  /** The issuing credential — persisted with the intent so cleanup revokes
   *  with the credential that ISSUED the certificate. */
  credentialId?: string | null;
  /** WILDCARD sharing: the certificate id of the shared active inventory the
   *  worker verified healthy on the edge (reuse short-circuit input). */
  activeCertificateId?: string | null;
  /**
   * Whether the domain's recorded ACTIVE inventory is believed healthy. The
   * worker checks the EDGE (fingerprint actually on disk) before calling —
   * database metadata alone can lie after a server rebuild. False (or an
   * expiry inside the rotation horizon) skips the reuse short-circuit so a
   * fresh issuance repairs/rotates. Default true (the ensure API's shape).
   */
  activeMaterialHealthy?: boolean;
}

/**
 * Rotation horizon: active material inside this window is replaced instead of
 * reused. Scaled to the requested validity — a 7-day certificate must rotate
 * days before expiry, a 5-year one follows the ordinary renewal horizon.
 */
function rotateHorizonMs(validityDays: OriginCaValidityDays): number {
  const days = Math.max(1, Math.min(SYSTEM.DOMAINS.SSL_RENEW_BEFORE_DAYS, validityDays / 2));
  return days * 86_400_000;
}

export type OriginCaIssuanceOutcome =
  | { outcome: "reused"; fingerprint: string; expiresAt: Date; issuanceId?: string }
  | { outcome: "issued"; issuanceId: string; fingerprint: string; expiresAt: Date; certificateId: string }
  | { outcome: "unknown"; reason: string };

/** The requested hostnames for the CSR: the exact hostname (wildcard sources
 *  are a separate shared-resource flow and never appear here). */
function csrHostnames(hostname: string): string[] {
  return [hostname.toLowerCase().replace(/\.$/, "")];
}

export async function ensureOriginCaIssued(input: OriginCaIssuanceInput): Promise<OriginCaIssuanceOutcome> {
  const hostname = input.hostname.toLowerCase().replace(/\.$/, "");
  const validityDays: OriginCaValidityDays = input.validityDays ?? DISCOVERY_TLS_ORIGIN_CA_DEFAULT_VALIDITY_DAYS;

  // 1. RESUME: a live issuance row owns this domain's in-flight work — BEFORE
  //    any reuse check, so an interrupted ROTATION (old certificate still
  //    active, new candidate in flight) resumes the candidate instead of
  //    short-circuiting on the old material.
  const domainRow = await repos.domain.findById(input.domainId);
  const live = await repos.discoveryTlsIssuance.findLiveIssuance(input.domainId);
  if (live) {
    if (live.state === "candidate" && live.certificatePem && live.certificateId && live.fingerprint && live.expiresOn) {
      // A recovered/stored candidate that was never activated: validate it
      // AGAIN against current expectations before re-presenting it (hostname
      // may have been re-pointed; material may have aged out).
      try {
        validateOriginCaCertificate(live.certificatePem, { hostname, publicKeyPem: publicKeyFor(live) });
        return {
          outcome: "issued",
          issuanceId: live.id,
          certificateId: live.certificateId,
          fingerprint: live.fingerprint,
          expiresAt: live.expiresOn,
        };
      } catch (error) {
        // Stale/unusable candidate: retire it visibly, then fall through to a
        // FRESH issuance (the live slot is free again).
        reportCaughtError(error, "platform/engine/modules/discovery/origin-ca-issuance");
        await repos.discoveryTlsIssuance.markFailed(live.id, "stored candidate no longer usable");
      }
    } else {
      // pending_create: ambiguity recovery — never a fresh create from here.
      return recoverPendingCreate(live.id, input.apiToken, hostname, validityDays);
    }
  }

  // 2b. REUSE: recorded ACTIVE inventory — exclusively healthy — short-circuits
  //    without ANY provider request (plan step 1). Healthy means: active
  //    provider is Origin CA, the caller found the material healthy ON THE
  //    EDGE, and the expiry is OUTSIDE the rotation horizon (a near-expiry
  //    certificate must be REPLACED, not reused forever).
  if (
    input.activeMaterialHealthy !== false &&
    domainRow?.tlsCertificateId &&
    domainRow.tlsActiveProvider === "cloudflare-origin-ca" &&
    domainRow.sslExpiresAt &&
    domainRow.sslExpiresAt.getTime() > Date.now() + rotateHorizonMs(input.validityDays ?? 365)
  ) {
    return {
      outcome: "reused",
      fingerprint: domainRow.tlsCertificateFingerprint ?? "unknown",
      expiresAt: domainRow.sslExpiresAt,
    };
  }

  // 3. FRESH: generate, persist the sealed intent, THEN request.
  const key = generateOriginCaKey();
  const csrDer = buildOriginCaCsr({ hostname, privateKeyPem: key.privateKeyPem });
  const csrPem = csrToPem(csrDer);
  const { issuance } = await repos.discoveryTlsIssuance.startIssuance({
    domainId: input.domainId,
    operationId: input.operationId,
    hostname,
    zoneId: input.zoneId,
    csrPem,
    keyEnc: encryptSecretField(key.privateKeyPem) ?? "",
    validityDays,
    credentialId: input.credentialId ?? null,
  });

  return createWithRecoveryOnAmbiguity(issuance.id, {
    apiToken: input.apiToken,
    hostname,
    hostnames: csrHostnames(hostname),
    csrPem,
    keyPem: key.publicKeyPem,
    zoneId: input.zoneId,
    validityDays,
  });
}

/** The public key of a stored (sealed) private key — recovery's decisive match. */
function publicKeyFor(live: { keyEnc: string }): string {
  const pem = decryptSecretField(live.keyEnc);
  if (!pem) throw new AppError("The pending Origin CA private key could not be unsealed", 500, "ORIGIN_CA_KEY_UNSEALED");
  return createPublicKey(pem).export({ type: "spki", format: "pem" }).toString();
}

/**
 * RECOVERY for a pending_create row (plan step 4): list certificates the
 * token can see IN THE PERSISTED ZONE (the list endpoint requires it), filter
 * to matching hostname sets, GET each candidate and compare the certificate's
 * public key against our pending key (the decisive, unforgeable match). A
 * definitive match is adopted; a revoked match is definitive too — the intent
 * is retired so a legitimate replacement can be issued. An inconclusive sweep
 * records ONE bounded recovery attempt and returns unknown — no create request
 * is issued from here, and an EXHAUSTED intent keeps occupying the live slot:
 * unresolved outcomes must never free the way for a blind re-create.
 */
async function recoverPendingCreate(
  issuanceId: string,
  apiToken: string,
  hostname: string,
  validityDays: OriginCaValidityDays,
): Promise<OriginCaIssuanceOutcome> {
  const row = await repos.discoveryTlsIssuance.findIssuanceById(issuanceId);
  if (!row) return { outcome: "unknown", reason: "the pending issuance row disappeared" };

  // BUDGET: attempts count CONCLUSIVE sweeps (provider looked at, no match
  // found). Once exhausted, the intent still keeps BLOCKING fresh creation —
  // the original create may have landed — but recovery READS continue on a
  // slow cadence (throttled by the row's last mutation) so a certificate
  // that surfaced later can still be adopted. Only a decisive finding (match,
  // revoked match, policy supersede, unreadable key) or an operator retires
  // the row.
  if (row.attempts >= MAX_RECOVERY_ATTEMPTS) {
    const sinceLastProgress = Date.now() - new Date(row.updatedAt).getTime();
    if (Number.isFinite(sinceLastProgress) && sinceLastProgress < RECOVERY_RECHECK_INTERVAL_MS) {
      return {
        outcome: "unknown",
        reason: `certificate creation outcome stayed unknown after ${row.attempts} recovery attempts; the unresolved issuance keeps blocking fresh creation; recovery re-checks on a slow cadence`,
      };
    }
  }
  // Cheap local check BEFORE any provider I/O: an intent whose key cannot be
  // unsealed (e.g. restored from a cross-instance dump that stripped it) can
  // never complete — retire it now; a fresh issuance follows next cycle.
  let keyPem: string;
  try {
    keyPem = publicKeyFor(row);
  } catch (error) {
    await repos.discoveryTlsIssuance.markFailed(issuanceId, error instanceof Error ? error.message : "key unseal failed");
    return { outcome: "unknown", reason: "the pending private key could not be unsealed; the issuance was retired" };
  }
  if (!row.zoneId) {
    return { outcome: "unknown", reason: "the pending issuance has no persisted zone to sweep" };
  }

  let summaries: OriginCaCertificateSummary[];
  try {
    summaries = await listOriginCaCertificates(apiToken, row.zoneId);
  } catch (error) {
    // TRANSIENT provider failure: NOT a recovery attempt — it consumed no
    // conclusive budget (the provider was never actually looked at), so five
    // Cloudflare outages must never permanently blind recovery.
    reportCaughtError(error, "platform/engine/modules/discovery/origin-ca-issuance");
    return {
      outcome: "unknown",
      reason: "provider unreadable during recovery; retrying without consuming the recovery budget",
    };
  }

  const intended = csrHostnames(hostname);
  const candidates = summaries.filter(
    (summary) =>
      !summary.revokedAt &&
      Array.isArray(summary.hostnames) &&
      summary.hostnames.length === intended.length &&
      summary.hostnames.every((name) => intended.includes(name.toLowerCase())),
  );

  for (const candidate of candidates) {
    if (!candidate.id) continue;
    let summary: OriginCaCertificateSummary;
    try {
      summary = await getOriginCaCertificate(apiToken, candidate.id);
    } catch (error) {
      reportCaughtError(error, "platform/engine/modules/discovery/origin-ca-issuance");
      continue; // a single unreadable candidate is skipped, not fatal
    }
    if (!summary.certificate) continue;
    try {
      const validated = validateOriginCaCertificate(summary.certificate, {
        hostname,
        publicKeyPem: keyPem,
      });
      // DECISIVE: hostname + key + trust all agree — this is OUR certificate.
      // Only NOW does revocation retire the intent: a same-hostname
      // certificate that belongs to ANOTHER key must never free the live
      // slot (it says nothing about our original create).
      if (summary.revokedAt) {
        await repos.discoveryTlsIssuance.markFailed(issuanceId, "the matching certificate is revoked; a fresh issuance follows");
        return {
          outcome: "unknown",
          reason: "the matching certificate is revoked; the issuance was retired",
        };
      }
      // DECISIVE match: hostname + key + validity all agree with our intent.
      const recorded = await repos.discoveryTlsIssuance.recordCandidate(issuanceId, {
        certificateId: candidate.id,
        certificatePem: summary.certificate,
        fingerprint: validated.fingerprint,
        expiresOn: validated.expiresAt,
      });
      if (!recorded) break; // lost the live slot to a supersede — stop
      return {
        outcome: "issued",
        issuanceId,
        certificateId: candidate.id,
        fingerprint: validated.fingerprint,
        expiresAt: validated.expiresAt,
      };
    } catch {
      continue; // not ours (wrong key/hostname/expiry): keep sweeping
    }
  }

  // Inconclusive CONCLUSIVE sweep: bounded visible attempts. The row REMAINS
  // pending_create — unresolved recovery must never free the live slot for a
  // blind re-create; past the budget the row re-checks on the slow cadence.
  const attempts = await repos.discoveryTlsIssuance.recordRecoveryAttempt(
    issuanceId,
    "recovery could not match a created certificate to this intent yet",
    new Date(),
  );
  return {
    outcome: "unknown",
    reason: `certificate creation outcome is unknown (recovery attempt ${attempts}); no duplicate is created`,
  };
}

/**
 * The FRESH create, with the ambiguity contract: a DEFINITIVE success is
 * validated then stored as candidate; a definitive rejection marks failed;
 * an AMBIGUOUS failure (CloudflareApiError — timeout/5xx/network, the request
 * may have landed) leaves pending_create untouched so the NEXT attempt takes
 * the recovery path instead of creating a duplicate.
 */
export async function createWithRecoveryOnAmbiguity(
  issuanceId: string,
  input: {
    apiToken: string;
    hostname: string;
    hostnames: string[];
    csrPem: string;
    keyPem: string;
    zoneId: string;
    validityDays: OriginCaValidityDays;
  },
): Promise<OriginCaIssuanceOutcome> {
  let summary: OriginCaCertificateSummary;
  try {
    summary = await createOriginCaCertificate(input.apiToken, {
      csrPem: input.csrPem,
      hostnames: input.hostnames,
      requestedValidityDays: input.validityDays,
    });
  } catch (error) {
    if (error instanceof CloudflareApiError) {
      // UNKNOWN outcome: persist nothing more, defer to recovery. The intent
      // (encrypted key + CSR) is already durable — this is the resumability
      // the whole design exists for.
      reportCaughtError(error, "platform/engine/modules/discovery/origin-ca-issuance");
      await repos.discoveryTlsIssuance.recordRecoveryAttempt(
        issuanceId,
        "create outcome unknown (timeout/provider error); recovery will match before any re-create",
        new Date(),
      );
      return {
        outcome: "unknown",
        reason: "the certificate create did not complete definitively; recovery will reconcile before re-creating",
      };
    }
    await repos.discoveryTlsIssuance.markFailed(
      issuanceId,
      error instanceof Error ? error.message : "certificate creation failed",
    );
    throw error;
  }

  // Definitive success: validate BEFORE storing the candidate.
  if (!summary.id || !summary.certificate) {
    await repos.discoveryTlsIssuance.markFailed(issuanceId, "the provider response carried no certificate or id");
    throw new AppError(
      "The Origin CA response carried no certificate or id; nothing was stored.",
      502,
      "ORIGIN_CA_RESPONSE_INVALID",
    );
  }
  const validated = validateOriginCaCertificate(summary.certificate, {
    hostname: input.hostname,
    publicKeyPem: input.keyPem,
  });
  await repos.discoveryTlsIssuance.recordCandidate(issuanceId, {
    certificateId: summary.id,
    certificatePem: summary.certificate,
    fingerprint: validated.fingerprint,
    expiresOn: validated.expiresAt,
  });
  return {
    outcome: "issued",
    issuanceId,
    certificateId: summary.id,
    fingerprint: validated.fingerprint,
    expiresAt: validated.expiresAt,
  };
}

/**
 * SHARED WILDCARD issuance (plan "Discovery TLS labels and wildcard certificate
 * sources"): every unsuppressed binding declaring `*.base` shares ONE
 * certificate for that pattern. The wildcard pattern is the issuance identity
 * — the inventory row's hostname IS the wildcard — and the edge resolves it
 * for every child through its parent-wildcard lookup (`certDir/<wildcard>/`).
 * Children never claim the base itself (a wildcard SAN does not cover it; the
 * base is its own exact-host reference).
 *
 * Phases mirror the exact flow: RESUME a live wildcard row (any sharing
 * domain's interrupted work is EVERYONE's), REUSE healthy shared inventory
 * (the worker has already verified the edge fingerprint), FRESH otherwise.
 */
export async function ensureWildcardOriginCaShared(
  input: OriginCaIssuanceInput & { /** REQUIRED: shared identity is scoped to the serving edge. */ serverId: string },
): Promise<OriginCaIssuanceOutcome> {
  const wildcard = input.hostname.toLowerCase().replace(/\.$/, "");

  // 1. RESUME: the live wildcard row (issued by ANY sharing domain) owns the
  //    pattern's in-flight work — a duplicate issuance here would defeat the
  //    entire sharing design.
  const live = await repos.discoveryTlsIssuance.findLiveWildcardIssuance(input.serverId, wildcard);
  if (live) {
    if (live.state === "candidate" && live.certificatePem && live.certificateId && live.fingerprint && live.expiresOn) {
      try {
        validateOriginCaCertificate(live.certificatePem, { hostname: wildcard, publicKeyPem: publicKeyFor(live) });
        return {
          outcome: "issued",
          issuanceId: live.id,
          certificateId: live.certificateId,
          fingerprint: live.fingerprint,
          expiresAt: live.expiresOn,
        };
      } catch (error) {
        // Stale/unusable shared candidate: retire and fall through to fresh.
        reportCaughtError(error, "platform/engine/modules/discovery/origin-ca-issuance");
        await repos.discoveryTlsIssuance.markFailed(live.id, "stored wildcard candidate no longer usable");
      }
    } else {
      // pending_create: ambiguity recovery — never a fresh create from here.
      return recoverPendingCreate(live.id, input.apiToken, wildcard, input.validityDays ?? 365);
    }
  }

  // 2. REUSE: the worker verified the edge already serves the shared wildcard
  //    certificate and identified the active inventory row — new sharing
  //    domains activate from that row; no provider request.
  if (input.activeMaterialHealthy !== false && input.activeCertificateId) {
    const issuing = await repos.discoveryTlsIssuance.findByCertificateId(input.activeCertificateId);
    // Rotation horizon — the SAME rule as exact issuance: near-expiry shared
    // material is replaced, not reused forever. Only ACTIVATED rows count
    // (a retired row's certificate was revoked; a failed one never served).
    const horizonMs = rotateHorizonMs(input.validityDays ?? 365);
    if (
      issuing &&
      issuing.state === "active" &&
      issuing.expiresOn &&
      issuing.expiresOn.getTime() > Date.now() + horizonMs
    ) {
      return {
        outcome: "reused",
        issuanceId: issuing.id,
        fingerprint: "shared",
        expiresAt: issuing.expiresOn,
      };
    }
  }

  // 3. FRESH: the shared pattern's first issuance.
  const key = generateOriginCaKey();
  const csrDer = buildOriginCaCsr({ hostname: wildcard, privateKeyPem: key.privateKeyPem });
  const csrPem = csrToPem(csrDer);
  const { issuance } = await repos.discoveryTlsIssuance.startIssuance({
    domainId: input.domainId,
    operationId: input.operationId,
    hostname: wildcard,
    zoneId: input.zoneId,
    csrPem,
    keyEnc: encryptSecretField(key.privateKeyPem) ?? "",
    validityDays: input.validityDays ?? 365,
    credentialId: input.credentialId ?? null,
  });
  return createWithRecoveryOnAmbiguity(issuance.id, {
    apiToken: input.apiToken,
    hostname: wildcard,
    hostnames: csrHostnames(wildcard),
    csrPem,
    keyPem: key.publicKeyPem,
    zoneId: input.zoneId,
    validityDays: input.validityDays ?? 365,
  });
}
