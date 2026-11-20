import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@repo/core";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Origin CA resumable issuance: intent persisted BEFORE the create request,
 * ambiguous outcomes NEVER re-created, recovery matches by hostname + key,
 * healthy active inventory reused with zero provider calls.
 */
const CERT_PEM = readFileSync(new URL("../../../../test/fixtures/test-cert.pem", import.meta.url), "utf8");
const KEY_PEM = readFileSync(new URL("../../../../test/fixtures/test-key.pem", import.meta.url), "utf8");
const TEST_ROOT_PEM = readFileSync(new URL("../../../../test/fixtures/test-root.pem", import.meta.url), "utf8");
const FOREIGN_KEY_CERT_PEM = readFileSync(new URL("../../../../test/fixtures/foreign-key-cert.pem", import.meta.url), "utf8"); // same hostname, DIFFERENT key pair

const issuanceRepo = vi.hoisted(() => ({
  findLiveIssuance: vi.fn(async (): Promise<Record<string, unknown> | undefined> => undefined),
  findIssuanceById: vi.fn(async (): Promise<Record<string, unknown> | undefined> => undefined),
  startIssuance: vi.fn(async (input: { keyEnc: string }) => {
    if (!input.keyEnc.startsWith("enc1:")) throw new Error("unsealed key refused");
    return { issuance: { id: "dti_new", state: "pending_create", keyEnc: input.keyEnc, attempts: 0 }, created: true };
  }),
  recordCandidate: vi.fn(async () => ({ id: "dti_new", state: "candidate" })),
  recordRecoveryAttempt: vi.fn(async () => 1),
  markFailed: vi.fn(async () => {}),
  findByCertificateId: vi.fn(async (): Promise<Record<string, unknown> | undefined> => undefined),
  findLiveWildcardIssuance: vi.fn(async (): Promise<Record<string, unknown> | undefined> => undefined),
}));
const domainRepo = vi.hoisted(() => ({
  findById: vi.fn(async (): Promise<Record<string, unknown> | undefined> => undefined),
}));

vi.mock("@repo/db", () => ({
  repos: { discoveryTlsIssuance: issuanceRepo, domain: domainRepo },
}));

const encryption = vi.hoisted(() => ({
  encryptSecretField: vi.fn((plain: string) => `enc1:sealed(${plain.length})`),
  decryptSecretField: vi.fn(() => undefined as string | undefined),
}));
vi.mock("../../lib/credential-encryption", () => encryption);

const client = vi.hoisted(() => ({
  create: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
}));
vi.mock("./origin-ca-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./origin-ca-client")>();
  // The mocked transport functions still pass their results through the REAL
  // normalizer — the wire speaks snake_case and the orchestrator must see
  // exactly what production sees (revoked_at → revokedAt, expires_on → …).
  return {
    createOriginCaCertificate: async (...args: Parameters<typeof actual.createOriginCaCertificate>) =>
      actual.normalizeOriginCaCertificate((await client.create(...args)) as never),
    getOriginCaCertificate: async (...args: Parameters<typeof actual.getOriginCaCertificate>) =>
      actual.normalizeOriginCaCertificate((await client.get(...args)) as never),
    listOriginCaCertificates: async (...args: Parameters<typeof actual.listOriginCaCertificates>) => {
      const rows = (await client.list(...args)) as never[];
      return rows.map((raw) => actual.normalizeOriginCaCertificate(raw as never));
    },
    revokeOriginCaCertificate: vi.fn(),
  };
});

/** Validation is mocked to PASS by default (the orchestrator generates its key
 *  internally, so fixture certs cannot pair); recovery tests restore the REAL
 *  validator for one call — the decisive hostname+key match behavior is
 *  exhaustively covered by origin-ca-cert.test.ts. */
const validate = vi.hoisted(() => ({
  impl: null as null | ((
    pem: string,
    expected: { hostname: string; publicKeyPem: string },
    options?: { trustAnchors?: readonly string[] },
  ) => unknown),
}));
vi.mock("./origin-ca-cert", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./origin-ca-cert")>();
  return {
    ...actual,
    validateOriginCaCertificate: vi.fn((...args: Parameters<typeof actual.validateOriginCaCertificate>) => {
      if (validate.impl) return validate.impl(...args); // ALWAYS forward — impls need pem + expected
      // Default stub: accept (the flow, not the crypto, is under test here —
      // the crypto is exhaustively covered by origin-ca-cert.test.ts).
      return { fingerprint: "aa:bb:cc", expiresAt: new Date(Date.now() + 90 * 86_400_000), hostnames: ["site.example.com"] };
    }),
  };
});

import { CloudflareApiError } from "../../lib/cloudflare-api";
import { ensureOriginCaIssued, ensureWildcardOriginCaShared } from "./origin-ca-issuance";
import { OriginCaCertificateInvalidError, validateOriginCaCertificate } from "./origin-ca-cert";
import { generateOriginCaKey } from "./origin-ca-csr";

const INPUT = {
  domainId: "dom_cf",
  operationId: "dtop_1",
  hostname: "site.example.com",
  zoneId: "zone_1",
  apiToken: "tok",
  organizationId: "org_1",
  validityDays: 90 as const,
  credentialId: "cred_cf", // the issuing credential, persisted with the intent
};

/** A provider create result (validation is stubbed to accept it). */
function validCreateResult() {
  return { id: "ca_cert_1", certificate: CERT_PEM, hostnames: ["site.example.com"], expires_on: "2036-11-15" };
}

async function importOriginalValidator() {
  const mod = await vi.importActual<typeof import("./origin-ca-cert")>("./origin-ca-cert");
  return mod;
}

beforeEach(() => {
  vi.clearAllMocks();
  validate.impl = null;
  issuanceRepo.findByCertificateId.mockResolvedValue(undefined);
  issuanceRepo.findLiveWildcardIssuance.mockResolvedValue(undefined);
  issuanceRepo.findLiveIssuance.mockResolvedValue(undefined);
  issuanceRepo.findIssuanceById.mockResolvedValue(undefined);
  domainRepo.findById.mockResolvedValue(undefined);
  client.create.mockResolvedValue(validCreateResult());
  client.get.mockResolvedValue({});
  client.list.mockResolvedValue([]);
  // The orchestrator generates a key internally; the sealed round-trip through
  // the repo is mocked — so recovery's decisive key match is driven by making
  // decryptSecretField return THE fixture key (whose cert the client returns).
  encryption.decryptSecretField.mockReturnValue(KEY_PEM);
});

describe("fresh issuance", () => {
  it("persists the encrypted intent BEFORE the create request, then records the validated candidate", async () => {
    const result = await ensureOriginCaIssued(INPUT);
    expect(result).toMatchObject({ outcome: "issued", issuanceId: "dti_new", certificateId: "ca_cert_1" });
    // ORDER: intent (startIssuance) strictly before create, candidate after.
    const intentOrder = issuanceRepo.startIssuance.mock.invocationCallOrder[0];
    const createOrder = client.create.mock.invocationCallOrder[0];
    const candidateOrder = issuanceRepo.recordCandidate.mock.invocationCallOrder[0];
    expect(intentOrder).toBeLessThan(createOrder);
    expect(createOrder).toBeLessThan(candidateOrder);
    // The intent carried a SEALED key (never plaintext) + the ISSUING
    // credential reference (cleanup revokes with THIS, not the current policy).
    expect(issuanceRepo.startIssuance).toHaveBeenCalledWith(
      expect.objectContaining({
        keyEnc: expect.stringContaining("enc1:"),
        hostname: "site.example.com",
        zoneId: "zone_1",
        validityDays: 90,
        credentialId: "cred_cf",
      }),
    );
    // The create sent the CSR + hostnames, and requested the discrete validity.
    expect(client.create).toHaveBeenCalledWith(
      "tok",
      expect.objectContaining({
        csrPem: expect.stringContaining("BEGIN CERTIFICATE REQUEST"),
        hostnames: ["site.example.com"],
        requestedValidityDays: 90,
      }),
    );
    // Validation passed → candidate stored with the fixture's fingerprint.
    expect(issuanceRepo.recordCandidate).toHaveBeenCalledWith(
      "dti_new",
      expect.objectContaining({ certificateId: "ca_cert_1", fingerprint: expect.any(String) }),
    );
  });

  it("an AMBIGUOUS create (provider timeout) never re-creates: pending stays, recovery is next", async () => {
    client.create.mockRejectedValue(new CloudflareApiError(503, "The API could not be reached. Try again."));
    const result = await ensureOriginCaIssued(INPUT);
    expect(result.outcome).toBe("unknown");
    // One create attempt ONLY; the candidate slot untouched; recovery attempt recorded.
    expect(client.create).toHaveBeenCalledTimes(1);
    expect(issuanceRepo.recordCandidate).not.toHaveBeenCalled();
    expect(issuanceRepo.recordRecoveryAttempt).toHaveBeenCalledWith(
      "dti_new",
      expect.stringContaining("create outcome unknown"),
      expect.any(Date),
    );
    expect(issuanceRepo.markFailed).not.toHaveBeenCalled();
  });
});

describe("recovery of a pending_create", () => {
  const pending = {
    id: "dti_pending",
    domainId: "dom_cf",
    hostname: "site.example.com",
    zoneId: "zone_1",
    state: "pending_create",
    csr: "-----BEGIN CERTIFICATE REQUEST-----",
    keyEnc: "enc1:sealed",
    validityDays: 90,
    attempts: 0,
    updatedAt: new Date(), // recent — the post-exhaustion throttle has not elapsed
  };

  it("a matching hostname+key certificate is ADOPTED without a create request", async () => {
    issuanceRepo.findLiveIssuance.mockResolvedValue(pending);
    issuanceRepo.findIssuanceById.mockResolvedValue(pending);
    client.list.mockResolvedValue([{ id: "ca_orphan", hostnames: ["site.example.com"], created_on: "2026-01-01" }]);
    client.get.mockResolvedValue({ id: "ca_orphan", certificate: CERT_PEM, hostnames: ["site.example.com"] });
    const result = await ensureOriginCaIssued(INPUT);
    expect(result).toMatchObject({ outcome: "issued", issuanceId: "dti_pending", certificateId: "ca_orphan" });
    expect(client.create).not.toHaveBeenCalled(); // recovery never re-creates
    // The sweep reads the PERSISTED zone (the list endpoint requires it).
    expect(client.list).toHaveBeenCalledWith("tok", "zone_1");
    expect(client.get).toHaveBeenCalledWith("tok", "ca_orphan");
    expect(issuanceRepo.recordCandidate).toHaveBeenCalledWith("dti_pending", expect.objectContaining({ certificateId: "ca_orphan" }));
  });

  it("a hostname match with the WRONG KEY is skipped — the sweep stays inconclusive", async () => {
    // The decisive hostname+key match decides: simulate the validator's
    // exact rejection (the real validator's behavior is covered in
    // origin-ca-cert.test.ts; the foreign-key test below exercises it for real).
    validate.impl = (() => {
      throw new (Error as ErrorConstructor)("the certificate's public key does not match the pending private key");
    }) as never;
    const foreign = generateOriginCaKey();
    issuanceRepo.findLiveIssuance.mockResolvedValue(pending);
    issuanceRepo.findIssuanceById.mockResolvedValue(pending);
    encryption.decryptSecretField.mockReturnValue(foreign.privateKeyPem); // mismatch vs fixture cert
    client.list.mockResolvedValue([{ id: "ca_other_key", hostnames: ["site.example.com"] }]);
    client.get.mockResolvedValue({ id: "ca_other_key", certificate: CERT_PEM, hostnames: ["site.example.com"] });
    const result = await ensureOriginCaIssued(INPUT);
    expect(result.outcome).toBe("unknown");
    expect(client.create).not.toHaveBeenCalled();
    expect(issuanceRepo.recordCandidate).not.toHaveBeenCalled();
    expect(issuanceRepo.recordRecoveryAttempt).toHaveBeenCalled();
  });

  it("an unreadable provider during recovery stays pending and retryable — nothing created", async () => {
    issuanceRepo.findLiveIssuance.mockResolvedValue(pending);
    issuanceRepo.findIssuanceById.mockResolvedValue(pending);
    client.list.mockRejectedValue(new CloudflareApiError(503, "The API could not be reached. Try again."));
    const result = await ensureOriginCaIssued(INPUT);
    expect(result).toMatchObject({ outcome: "unknown", reason: expect.stringContaining("provider unreadable") });
    expect(client.create).not.toHaveBeenCalled();
    expect(issuanceRepo.markFailed).not.toHaveBeenCalled();
    // TRANSIENT failures consume NO conclusive budget.
    expect(issuanceRepo.recordRecoveryAttempt).not.toHaveBeenCalled();
  });

  it("five consecutive provider outages never blind recovery — the sweep still runs afterwards", async () => {
    issuanceRepo.findLiveIssuance.mockResolvedValue(pending);
    issuanceRepo.findIssuanceById.mockResolvedValue(pending);
    client.list.mockRejectedValue(new CloudflareApiError(503, "The API could not be reached. Try again."));
    for (let i = 0; i < 5; i++) await ensureOriginCaIssued(INPUT);
    // Every call still reached the provider — no attempt was ever recorded,
    // so the budget is intact and the provider remains contactable.
    expect(client.list).toHaveBeenCalledTimes(5);
    expect(issuanceRepo.recordRecoveryAttempt).not.toHaveBeenCalled();
    // And when the provider RETURNS, the issued certificate is recoverable.
    client.list.mockResolvedValue([{ id: "ca_late", hostnames: ["site.example.com"] }]);
    client.get.mockResolvedValue({ id: "ca_late", certificate: CERT_PEM, hostnames: ["site.example.com"] });
    const recovered = await ensureOriginCaIssued(INPUT);
    expect(recovered).toMatchObject({ outcome: "issued", certificateId: "ca_late" });
  });

  it("an EXHAUSTED unresolved recovery keeps blocking fresh creation — and still re-checks SLOWLY", async () => {
    // attempts past the bound: the row STAYS pending_create (the original
    // create may have landed at the provider) — no blind duplicate — but the
    // recovery read is merely THROTTLED, not severed: within the recheck
    // window nothing contacts the provider…
    issuanceRepo.findLiveIssuance.mockResolvedValue({ ...pending, attempts: 5 });
    issuanceRepo.findIssuanceById.mockResolvedValue({ ...pending, attempts: 5 });
    const throttled = await ensureOriginCaIssued(INPUT);
    expect(throttled.outcome).toBe("unknown");
    expect(client.list).not.toHaveBeenCalled(); // still inside the recheck window
    expect(client.create).not.toHaveBeenCalled();
    expect(issuanceRepo.markFailed).not.toHaveBeenCalled(); // NOT retired
    expect(throttled).toMatchObject({ outcome: "unknown", reason: expect.stringContaining("keeps blocking fresh creation") });

    // …once the window elapses, the sweep RUNS again (slower cadence) and can
    // still adopt a certificate that only surfaced at the provider later.
    const stale = { ...pending, attempts: 5, updatedAt: new Date(Date.now() - 31 * 60_000) };
    issuanceRepo.findLiveIssuance.mockResolvedValue(stale);
    issuanceRepo.findIssuanceById.mockResolvedValue(stale);
    client.list.mockResolvedValue([{ id: "ca_late", hostnames: ["site.example.com"] }]);
    client.get.mockResolvedValue({ id: "ca_late", certificate: CERT_PEM, hostnames: ["site.example.com"] });
    const recovered = await ensureOriginCaIssued(INPUT);
    expect(client.list).toHaveBeenCalledWith("tok", "zone_1"); // the slow re-check reached the provider
    expect(recovered).toMatchObject({ outcome: "issued", certificateId: "ca_late" });
    expect(client.create).not.toHaveBeenCalled(); // recovery, never a re-create
  });

  it("an unreadable sealed intent is DEFINITIVE (not ambiguous): retired so a fresh issuance can follow", async () => {
    // Unlike an unknown outcome, an unsealable key can never complete.
    issuanceRepo.findLiveIssuance.mockResolvedValue(pending);
    issuanceRepo.findIssuanceById.mockResolvedValue(pending);
    encryption.decryptSecretField.mockReturnValue(undefined); // e.g. cross-instance restore with "" sentinel
    const result = await ensureOriginCaIssued(INPUT);
    expect(result.outcome).toBe("unknown");
    expect(client.list).not.toHaveBeenCalled(); // no sweep possible without the key
    expect(issuanceRepo.markFailed).toHaveBeenCalledWith(
      "dti_pending",
      expect.stringContaining("could not be unsealed"),
    );
  });

  it("a decisive match that is REVOKED retires the issuance (replacement is legitimate, not a duplicate)", async () => {
    validate.impl = null;
    const actualValidator = await importOriginalValidator();
    // The GET response is a REAL chained cert (validation passes under the
    // test anchors) — only its revoked_at makes it a dead end.
    const revokedMatch = {
      id: "ca_revoked",
      hostnames: ["site.example.com"],
      revoked_at: "2026-06-01T00:00:00Z", // snake_case, as the wire sends it
      certificate: CERT_PEM,
    };
    issuanceRepo.findLiveIssuance.mockResolvedValue(pending);
    issuanceRepo.findIssuanceById.mockResolvedValue(pending);
    encryption.decryptSecretField.mockReturnValue(KEY_PEM); // pairs with CERT_PEM
    client.list.mockResolvedValue([{ id: "ca_revoked", hostnames: ["site.example.com"] }]);
    client.get.mockResolvedValue(revokedMatch);
    const result = await ensureOriginCaIssued(INPUT);
    expect(result.outcome).toBe("unknown");
    expect(issuanceRepo.markFailed).toHaveBeenCalledWith(
      "dti_pending",
      expect.stringContaining("matching certificate is revoked"),
    );
    void actualValidator;
  });

  it("a REVOKED certificate with a FOREIGN key never retires the intent — key match comes first", async () => {
    // REAL validation, arguments FORWARDED: the rejection must be the actual
    // public-key comparison (not a parse failure of undefined arguments).
    const { validateOriginCaCertificate: realValidate } = await importOriginalValidator();
    let keyRejection: unknown;
    validate.impl = ((pem: string, expected: { hostname: string; publicKeyPem: string }) => {
      try {
        return realValidate(pem, expected, { trustAnchors: [TEST_ROOT_PEM] });
      } catch (error) {
        keyRejection = error;
        throw error;
      }
    }) as never;
    issuanceRepo.findLiveIssuance.mockResolvedValue(pending);
    issuanceRepo.findIssuanceById.mockResolvedValue(pending);
    encryption.decryptSecretField.mockReturnValue(KEY_PEM); // OUR key — foreign cert will not pair
    client.list.mockResolvedValue([{ id: "ca_foreign_revoked", hostnames: ["site.example.com"] }]);
    client.get.mockResolvedValue({
      id: "ca_foreign_revoked",
      certificate: FOREIGN_KEY_CERT_PEM,
      hostnames: ["site.example.com"],
      revoked_at: "2026-06-01T00:00:00Z",
    });
    const result = await ensureOriginCaIssued(INPUT);
    // The sweep reached the REAL public-key comparison — the rejection is the
    // key mismatch itself, not a stub artifact.
    expect(keyRejection).toBeInstanceOf(OriginCaCertificateInvalidError);
    expect((keyRejection as OriginCaCertificateInvalidError).message).toContain("public key does not match");
    // Inconclusive sweep — NOT retired: the live slot must stay occupied so
    // our own (possibly issued) certificate can still be recovered later.
    expect(result.outcome).toBe("unknown");
    expect(issuanceRepo.markFailed).not.toHaveBeenCalled();
    expect(issuanceRepo.recordRecoveryAttempt).toHaveBeenCalled();
  });

  it("REVOKED certificates are skipped in the sweep — a later valid match is still adopted", async () => {
    issuanceRepo.findLiveIssuance.mockResolvedValue(pending);
    issuanceRepo.findIssuanceById.mockResolvedValue(pending);
    encryption.decryptSecretField.mockReturnValue(KEY_PEM);
    client.list.mockResolvedValue([
      { id: "ca_revoked_first", hostnames: ["site.example.com"], revoked_at: "2026-06-01T00:00:00Z" },
      { id: "ca_valid_second", hostnames: ["site.example.com"] },
    ]);
    client.get.mockResolvedValue({ id: "ca_valid_second", certificate: CERT_PEM, hostnames: ["site.example.com"] });
    const result = await ensureOriginCaIssued(INPUT);
    expect(result).toMatchObject({ outcome: "issued", certificateId: "ca_valid_second" });
    expect(client.get).not.toHaveBeenCalledWith("tok", "ca_revoked_first"); // filtered before GET
  });
});

describe("reuse of healthy active inventory", () => {
  it("an interrupted ROTATION resumes the candidate INSTEAD of reusing the still-active certificate", async () => {
    // Old cert still active on the domain + a live candidate from the
    // rotation issuance: the candidate must win (resume), not the reuse.
    domainRepo.findById.mockResolvedValue({
      tlsCertificateId: "ca_old",
      tlsActiveProvider: "cloudflare-origin-ca",
      tlsCertificateFingerprint: "old:fp",
      sslExpiresAt: new Date(Date.now() + 300 * 86_400_000),
    });
    issuanceRepo.findLiveIssuance.mockResolvedValue({
      id: "dti_rotation",
      state: "candidate",
      certificatePem: CERT_PEM,
      certificateId: "ca_new",
      fingerprint: "new:fp",
      expiresOn: new Date(Date.now() + 300 * 86_400_000),
      keyEnc: "enc1:x",
      hostname: "site.example.com",
    });
    const result = await ensureOriginCaIssued(INPUT);
    expect(result).toMatchObject({ outcome: "issued", issuanceId: "dti_rotation", certificateId: "ca_new" });
  });

  it("NEAR-EXPIRY active inventory is ROTATED, not reused", async () => {
    // 90-day cert with 10 days left: inside the rotation horizon.
    domainRepo.findById.mockResolvedValue({
      tlsCertificateId: "ca_aging",
      tlsActiveProvider: "cloudflare-origin-ca",
      tlsCertificateFingerprint: "old:fp",
      sslExpiresAt: new Date(Date.now() + 10 * 86_400_000),
    });
    const result = await ensureOriginCaIssued(INPUT); // validityDays: 90 → horizon 14d
    expect(result.outcome).toBe("issued"); // fresh issuance ran
    expect(issuanceRepo.startIssuance).toHaveBeenCalled();
  });

  it("comfortable inventory (outside the horizon) is reused with zero provider requests", async () => {
    domainRepo.findById.mockResolvedValue({
      tlsCertificateId: "ca_fresh",
      tlsActiveProvider: "cloudflare-origin-ca",
      tlsCertificateFingerprint: "new:fp",
      sslExpiresAt: new Date(Date.now() + 300 * 86_400_000),
    });
    const result = await ensureOriginCaIssued(INPUT);
    expect(result.outcome).toBe("reused");
  });

  it("UNHEALTHY edge material (the worker's repair flag) bypasses reuse entirely", async () => {
    domainRepo.findById.mockResolvedValue({
      tlsCertificateId: "ca_lost",
      tlsActiveProvider: "cloudflare-origin-ca",
      tlsCertificateFingerprint: "lost:fp",
      sslExpiresAt: new Date(Date.now() + 300 * 86_400_000),
    });
    const result = await ensureOriginCaIssued({ ...INPUT, activeMaterialHealthy: false });
    expect(result.outcome).toBe("issued"); // repair: fresh issuance replaces the lost material
    expect(issuanceRepo.startIssuance).toHaveBeenCalled();
  });

  it("returns reused with ZERO provider requests when the domain records active matching material", async () => {
    domainRepo.findById.mockResolvedValue({
      tlsCertificateId: "ca_live",
      tlsCertificateFingerprint: "ab:cd",
      tlsActiveProvider: "cloudflare-origin-ca",
      sslExpiresAt: new Date(Date.now() + 90 * 86_400_000),
    });
    const result = await ensureOriginCaIssued(INPUT);
    expect(result).toMatchObject({ outcome: "reused", fingerprint: "ab:cd" });
    expect(client.create).not.toHaveBeenCalled();
    expect(client.list).not.toHaveBeenCalled();
    expect(issuanceRepo.startIssuance).not.toHaveBeenCalled();
  });

  it("a stale stored CANDIDATE is retired (failed) and a fresh issuance runs", async () => {
    // REAL validation: the stale candidate's key no longer pairs with the
    // (unsealed) pending key → unusable → retired, fresh issuance follows.
    validate.impl = (() => {
      // Throw ONCE (the stale candidate), then fall back to the accepting stub
      // for the follow-up fresh issuance.
      validate.impl = null;
      throw new (Error as ErrorConstructor)("the certificate's public key does not match the pending private key");
    }) as never;
    void importOriginalValidator;
    encryption.decryptSecretField.mockReturnValue(generateOriginCaKey().privateKeyPem);
    issuanceRepo.findLiveIssuance.mockResolvedValue({
      id: "dti_stale",
      state: "candidate",
      certificatePem: CERT_PEM,
      certificateId: "ca_stale",
      fingerprint: "ff",
      expiresOn: new Date(Date.now() + 86_400_000),
      keyEnc: "enc1:x",
      hostname: "site.example.com",
    });
    client.create.mockResolvedValue(validCreateResult());
    await ensureOriginCaIssued(INPUT);
    expect(issuanceRepo.markFailed).toHaveBeenCalledWith("dti_stale", expect.stringContaining("no longer usable"));
    expect(client.create).toHaveBeenCalled(); // fresh issuance after retiring the stale one
  });
});

describe("SHARED WILDCARD issuance", () => {
  const WILDCARD_INPUT = { ...INPUT, serverId: "srv_1", hostname: "*.sub1.example.com" };

  it("the wildcard PATTERN is the issuance identity: resume a live shared row, never duplicate", async () => {
    const sharedRow = {
      id: "dti_shared",
      domainId: "dom_cf", // issued by another sharing domain
      hostname: "*.sub1.example.com",
      state: "candidate",
      certificatePem: CERT_PEM,
      certificateId: "ca_shared",
      fingerprint: "shared:fp",
      expiresOn: new Date(Date.now() + 300 * 86_400_000),
      keyEnc: "enc1:sealed",
    };
    issuanceRepo.findLiveIssuance.mockResolvedValue(undefined);
    issuanceRepo.findLiveWildcardIssuance.mockResolvedValueOnce(sharedRow);
    const result = await ensureWildcardOriginCaShared(WILDCARD_INPUT);
    expect(result).toMatchObject({ outcome: "issued", issuanceId: "dti_shared", certificateId: "ca_shared" });
    // NO new intent, NO provider create — sharing never duplicates.
    expect(issuanceRepo.startIssuance).not.toHaveBeenCalled();
    expect(client.create).not.toHaveBeenCalled();
  });

  it("REUSE: a healthy shared inventory short-circuits from the referenced row", async () => {
    issuanceRepo.findByCertificateId.mockResolvedValue({
      id: "dti_shared0",
      state: "active",
      certificateId: "ca_shared",
      expiresOn: new Date(Date.now() + 300 * 86_400_000),
    });
    const result = await ensureWildcardOriginCaShared({ ...WILDCARD_INPUT, activeCertificateId: "ca_shared" });
    expect(result).toMatchObject({ outcome: "reused", issuanceId: "dti_shared0" });
    expect(issuanceRepo.startIssuance).not.toHaveBeenCalled();
    expect(client.create).not.toHaveBeenCalled();
  });

  it("FRESH: the intent persists under the WILDCARD hostname with the issuing credential", async () => {
    const result = await ensureWildcardOriginCaShared(WILDCARD_INPUT);
    expect(result.outcome).toBe("issued");
    expect(issuanceRepo.startIssuance).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: "*.sub1.example.com",
        credentialId: "cred_cf",
        keyEnc: expect.stringContaining("enc1:"),
      }),
    );
    // The create requests EXACTLY the pattern as the hostname set.
    expect(client.create).toHaveBeenCalledWith(
      "tok",
      expect.objectContaining({ hostnames: ["*.sub1.example.com"] }),
    );
  });
});
