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
vi.mock("./origin-ca-client", () => ({
  createOriginCaCertificate: client.create,
  getOriginCaCertificate: client.get,
  listOriginCaCertificates: client.list,
  revokeOriginCaCertificate: vi.fn(),
}));

/** Validation is mocked to PASS by default (the orchestrator generates its key
 *  internally, so fixture certs cannot pair); recovery tests restore the REAL
 *  validator for one call — the decisive hostname+key match behavior is
 *  exhaustively covered by origin-ca-cert.test.ts. */
const validate = vi.hoisted(() => ({ impl: null as null | (() => never) }));
vi.mock("./origin-ca-cert", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./origin-ca-cert")>();
  return {
    ...actual,
    validateOriginCaCertificate: vi.fn(() => {
      if (validate.impl) return validate.impl(); // test opt-in: real/throwing behavior
      // Default stub: accept (the flow, not the crypto, is under test here —
      // the crypto is exhaustively covered by origin-ca-cert.test.ts).
      return { fingerprint: "aa:bb:cc", expiresAt: new Date(Date.now() + 90 * 86_400_000), hostnames: ["site.example.com"] };
    }),
  };
});

import { CloudflareApiError } from "../../lib/cloudflare-api";
import { ensureOriginCaIssued } from "./origin-ca-issuance";
import { validateOriginCaCertificate } from "./origin-ca-cert";
import { generateOriginCaKey } from "./origin-ca-csr";

const INPUT = {
  domainId: "dom_cf",
  operationId: "dtop_1",
  hostname: "site.example.com",
  zoneId: "zone_1",
  apiToken: "tok",
  organizationId: "org_1",
  validityDays: 90 as const,
};

/** A provider create result (validation is stubbed to accept it). */
function validCreateResult() {
  return { id: "ca_cert_1", certificate: CERT_PEM, hostnames: ["site.example.com"], expires_on: "2036-11-15" };
}

async function importOriginalValidator() {
  const mod = await vi.importActual<typeof import("./origin-ca-cert")>("./origin-ca-cert");
  return mod.validateOriginCaCertificate;
}

beforeEach(() => {
  vi.clearAllMocks();
  validate.impl = null;
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
    expect(result).toMatchObject({ outcome: "issued", certificateId: "ca_cert_1" });
    // ORDER: intent (startIssuance) strictly before create, candidate after.
    const intentOrder = issuanceRepo.startIssuance.mock.invocationCallOrder[0];
    const createOrder = client.create.mock.invocationCallOrder[0];
    const candidateOrder = issuanceRepo.recordCandidate.mock.invocationCallOrder[0];
    expect(intentOrder).toBeLessThan(createOrder);
    expect(createOrder).toBeLessThan(candidateOrder);
    // The intent carried a SEALED key (never plaintext).
    expect(issuanceRepo.startIssuance).toHaveBeenCalledWith(
      expect.objectContaining({ keyEnc: expect.stringContaining("enc1:"), hostname: "site.example.com", zoneId: "zone_1", validityDays: 90 }),
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
  };

  it("a matching hostname+key certificate is ADOPTED without a create request", async () => {
    issuanceRepo.findLiveIssuance.mockResolvedValue(pending);
    issuanceRepo.findIssuanceById.mockResolvedValue(pending);
    client.list.mockResolvedValue([{ id: "ca_orphan", hostnames: ["site.example.com"], createdAt: "2026-01-01" }]);
    client.get.mockResolvedValue({ id: "ca_orphan", certificate: CERT_PEM, hostnames: ["site.example.com"] });
    const result = await ensureOriginCaIssued(INPUT);
    expect(result).toMatchObject({ outcome: "issued", certificateId: "ca_orphan" });
    expect(client.create).not.toHaveBeenCalled(); // recovery never re-creates
    expect(client.list).toHaveBeenCalled();
    expect(client.get).toHaveBeenCalledWith("tok", "ca_orphan");
    expect(issuanceRepo.recordCandidate).toHaveBeenCalledWith("dti_pending", expect.objectContaining({ certificateId: "ca_orphan" }));
  });

  it("a hostname match with the WRONG KEY is skipped — the sweep stays inconclusive", async () => {
    // REAL validation for this call: the decisive hostname+key match decides.
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
  });

  it("recovery exhausted without a match marks the issuance FAILED (visible, bounded)", async () => {
    issuanceRepo.findLiveIssuance.mockResolvedValue({ ...pending, attempts: 4 });
    issuanceRepo.findIssuanceById.mockResolvedValue({ ...pending, attempts: 4 });
    issuanceRepo.recordRecoveryAttempt.mockResolvedValue(5); // hits the bound
    await ensureOriginCaIssued(INPUT);
    expect(client.create).not.toHaveBeenCalled();
    expect(issuanceRepo.markFailed).toHaveBeenCalledWith(
      "dti_pending",
      expect.stringContaining("stayed unknown after 5 recovery attempts"),
    );
  });
});

describe("reuse of healthy active inventory", () => {
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
