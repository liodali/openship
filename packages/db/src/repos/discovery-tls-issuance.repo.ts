import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../client";
import { discoveryTlsIssuance as issuance, domain } from "../schema";

export type DiscoveryTlsIssuance = typeof issuance.$inferSelect;

/** Live states: an intent (or its candidate) still owns this domain's issuance. */
const LIVE_STATES = ["pending_create", "candidate"] as const;

/**
 * Origin CA issuance inventory (plan §1/§3): durable intent BEFORE the create
 * request, candidate after. The encrypted private key (enc1: envelope) lives
 * only in key_enc and never leaves this table.
 */
export function createDiscoveryTlsIssuanceRepo(db: Database) {
  return {
    /**
     * Persist the issuance INTENT — CSR + encrypted key + zone/validity —
     * BEFORE any provider request exists (plan: "Persist an issuance intent
     * and recoverable CSR/key before the API call"). Idempotent: a live row
     * (pending_create/candidate) is returned as-is so a retrying worker
     * resumes it instead of generating a second key/certificate.
     */
    async startIssuance(input: {
      domainId: string;
      operationId: string | null;
      hostname: string;
      zoneId: string;
      csrPem: string;
      /** The private key ALREADY SEALED in the enc1: envelope — sealing stays
       *  at the platform edge (the envelope's cipher lives there); this repo is
       *  pure persistence and never sees plaintext key material. */
      keyEnc: string;
      validityDays: number;
    }): Promise<{ issuance: DiscoveryTlsIssuance; created: boolean }> {
      if (!input.keyEnc.startsWith("enc1:"))
        throw new Error("Refusing to persist an unsealed Origin CA private key");
      const [created] = await db
        .insert(issuance)
        .values({
          domainId: input.domainId,
          operationId: input.operationId,
          hostname: input.hostname.toLowerCase(),
          zoneId: input.zoneId,
          state: "pending_create",
          csr: input.csrPem,
          keyEnc: input.keyEnc,
          validityDays: input.validityDays,
        })
        // The partial unique index arbitrates: an in-flight issuance for the
        // domain is resumed, not duplicated.
        .onConflictDoNothing()
        .returning();
      if (created) return { issuance: created, created: true };
      const existing = await this.findLiveIssuance(input.domainId);
      if (!existing) throw new Error("Issuance dedup read lost its row; retrying is safe");
      return { issuance: existing, created: false };
    },

    /** One issuance row by id (recovery reads: csr, key_enc, attempts). */
    findIssuanceById(id: string) {
      return db.query.discoveryTlsIssuance.findFirst({ where: eq(issuance.id, id) });
    },

    /** The live (pending_create/candidate) issuance for a domain, or null. */
    findLiveIssuance(domainId: string) {
      return db.query.discoveryTlsIssuance.findFirst({
        where: and(eq(issuance.domainId, domainId), inArray(issuance.state, [...LIVE_STATES])),
      });
    },

    /** Bump recovery attempts (visible state for a stuck pending_create). */
    async recordRecoveryAttempt(id: string, reason: string, now = new Date()): Promise<number> {
      const [row] = await db
        .update(issuance)
        .set({
          attempts: sql`${issuance.attempts} + 1`,
          reason: reason.slice(0, 500),
          updatedAt: now,
        })
        .where(and(eq(issuance.id, id), eq(issuance.state, "pending_create")))
        .returning();
      return row?.attempts ?? 0;
    },

    /**
     * Persist the provider's returned candidate (from create OR recovery):
     * certificate id, PUBLIC pem, fingerprint, expiry. Only from
     * pending_create — the state machine's single forward transition.
     */
    async recordCandidate(
      id: string,
      input: { certificateId: string; certificatePem: string; fingerprint: string; expiresOn: Date },
      now = new Date(),
    ): Promise<DiscoveryTlsIssuance | undefined> {
      const [row] = await db
        .update(issuance)
        .set({
          state: "candidate",
          certificateId: input.certificateId,
          certificatePem: input.certificatePem,
          fingerprint: input.fingerprint,
          expiresOn: input.expiresOn,
          reason: null,
          updatedAt: now,
        })
        .where(and(eq(issuance.id, id), eq(issuance.state, "pending_create")))
        .returning();
      return row;
    },

    /**
     * Installation/activation commit (plan §3 step 7: "Commit active metadata
     * after successful activation"): advances the DOMAIN's active inventory
     * (certificate id + fingerprint) and flips the issuance row active.
     * Called only after Edge activation succeeded; recovery after a crash
     * inspects the installed fingerprint and re-commits without another
     * provider request.
     */
    /**
     * Durable activation: the domain's active inventory (certificate id,
     * fingerprint, active provider, expiry, VERIFIED) and the issuance row
     * flipping active — pending key material wiped in the same transaction.
     *
     * FENCED against a policy that moved on while the installation ran: the
     * caller must present the intent the certificate was issued FOR, and the
     * domain row is re-checked UNDER the write lock against server ownership,
     * provider, and policy generation. A stale activation writes NOTHING (the
     * key is not wiped either) and reports the reason; the caller retires the
     * superseded intent. Both the fresh-install path and the crash-recovery
     * path converge here — including `verified`, so recovery can never leave
     * the domain permanently unverified.
     */
    async markActive(
      input: {
        issuanceId: string;
        domainId: string;
        /** Fence: the intent the installed certificate belongs to. */
        expectedServerId: string;
        expectedTlsProvider: string;
        expectedPolicyGeneration: number;
      },
      now = new Date(),
    ): Promise<{ activated: boolean; reason?: string }> {
      return db.transaction(async (tx): Promise<{ activated: boolean; reason?: string }> => {
        const [row] = await tx
          .select()
          .from(issuance)
          .where(eq(issuance.id, input.issuanceId))
          .for("update");
        if (!row?.certificateId || !row?.fingerprint) return { activated: false, reason: "the issuance row has no candidate material" };
        const [domainRow] = await tx
          .select()
          .from(domain)
          .where(eq(domain.id, input.domainId))
          .for("update");
        if (!domainRow) return { activated: false, reason: "the domain row disappeared while installation ran" };
        if (domainRow.serverId !== input.expectedServerId) {
          return { activated: false, reason: `the domain moved to server ${domainRow.serverId ?? "(none)"} while installation ran` };
        }
        if (domainRow.tlsProvider !== input.expectedTlsProvider) {
          return { activated: false, reason: `the TLS policy switched to ${domainRow.tlsProvider ?? "(none)"} while installation ran` };
        }
        if (domainRow.tlsPolicyGeneration !== input.expectedPolicyGeneration) {
          return {
            activated: false,
            reason: `the TLS policy generation moved to ${domainRow.tlsPolicyGeneration ?? "(none)"} while installation ran`,
          };
        }
        await tx
          .update(domain)
          .set({
            tlsCertificateId: row.certificateId,
            tlsCertificateFingerprint: row.fingerprint,
            tlsActiveProvider: "cloudflare-origin-ca",
            sslStatus: "active",
            sslExpiresAt: row.expiresOn,
            sslIssuer: "cloudflare-origin-ca",
            // Verification lifecycle, the same fields markServerDomainVerified
            // writes — committed WITH the inventory so both the fresh-install
            // and crash-recovery paths converge identically (a newly discovered
            // domain must not stay status "pending"/verifiedAt-less while
            // serving an active certificate).
            verified: true,
            verifiedAt: now,
            status: "active",
            verifyAttempts: 0,
            lastVerifyError: null,
            lastCheckedAt: now,
            updatedAt: now,
          })
          .where(eq(domain.id, input.domainId));
        await tx
          .update(issuance)
          .set({
            state: "active",
            // Pending key material is wiped in the SAME transaction that makes
            // the row active: the private key now lives only on the server's
            // edge (installed alongside the certificate); the instance keeps
            // no sealed copy after durable success. Rotation creates a NEW
            // issuance with a NEW key, so nothing active ever needs this.
            keyEnc: "",
            reason: null,
            updatedAt: now,
          })
          .where(eq(issuance.id, input.issuanceId));
        return { activated: true };
      });
    },

    /** Actionable failure (visible, terminal for this attempt's intent). */
    async markFailed(id: string, reason: string, now = new Date()): Promise<void> {
      await db
        .update(issuance)
        .set({ state: "failed", reason: reason.slice(0, 500), updatedAt: now })
        .where(and(eq(issuance.id, id), inArray(issuance.state, [...LIVE_STATES])));
    },

    /** Superseded by a policy change: free the live slot, keep history. */
    async markSuperseded(id: string, now = new Date()): Promise<void> {
      await db
        .update(issuance)
        .set({ state: "failed", reason: "superseded by a policy change", updatedAt: now })
        .where(and(eq(issuance.id, id), inArray(issuance.state, [...LIVE_STATES])));
    },

    /** Lookup by provider certificate id (recovery + revoke paths). */
    findByCertificateId(certificateId: string) {
      return db.query.discoveryTlsIssuance.findFirst({
        where: eq(issuance.certificateId, certificateId),
      });
    },
  };
}

export type DiscoveryTlsIssuanceRepo = ReturnType<typeof createDiscoveryTlsIssuanceRepo>;
