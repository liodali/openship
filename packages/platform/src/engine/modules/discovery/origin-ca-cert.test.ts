import { createHash, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateOriginCaKey } from "./origin-ca-csr";
import { OriginCaCertificateInvalidError, validateOriginCaCertificate } from "./origin-ca-cert";
import {
  CLOUDFLARE_ORIGIN_CA_ECC_ROOT,
  CLOUDFLARE_ORIGIN_CA_RSA_ROOT,
  ORIGIN_CA_TRUST_ANCHORS,
} from "./origin-ca-trust-roots";
import { verifyOriginCaChain } from "./origin-ca-trust";

/**
 * Origin CA certificate validation: signature trust against the Cloudflare
 * Origin CA roots FIRST, then hostname coverage, public-key pairing, and live
 * validity — every rejection path fires BEFORE a candidate is ever stored or
 * installed. Issuer TEXT is never consulted: the adversarial fixtures carry
 * "Cloudflare Origin CA" in their issuer/subject and must still be rejected.
 */
const FIXTURES = new URL("../../../../test/fixtures/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, FIXTURES), "utf8");
const CERT_PEM = read("test-cert.pem"); // signed directly by the test root; SAN: site.example.com (real Origin CA topology)
const INTERMEDIATE_PEM = read("test-intermediate.pem"); // CA under the test root — for two-hop blob tests
const ROOT_PEM = read("test-root.pem"); // the test trust anchor
const EXPIRED_PEM = read("expired-cert.pem"); // chained, same key — validity window 2024→2025
const IMPOSTOR_PEM = read("other-issuer-cert.pem"); // signed by an UNRELATED CA, same key, "Cloudflare Origin CA" text
const NONCA_PEM = read("nonca-cert.pem"); // CA:FALSE cert signed by the test root (looks like an issuer, is not)
const NONCA_LEAF_PEM = read("leaf-signed-by-nonca.pem"); // signed BY that non-CA cert — OpenSSL rejects
const EXPIRED_INTERMEDIATE_PEM = read("expired-intermediate.pem"); // live CA semantics, dead window
const LEAF_UNDER_EXPIRED_PEM = read("leaf-under-expired-intermediate.pem"); // its child
const SELF_SIGNED_PEM = read("self-signed-cert.pem"); // self-signed, same key
const WRONG_HOST_PEM = read("wrong-host-cert.pem"); // chained, same key, SAN: elsewhere.example.com
const KEY_PEM = read("test-key.pem"); // the fixture's own private key

describe("bundled Cloudflare Origin CA trust anchors", () => {
  it("parses as self-signed CAs with the pinned fingerprints (substitution is caught by test)", () => {
    const pins: Array<[string, string, string]> = [
      [CLOUDFLARE_ORIGIN_CA_RSA_ROOT, "D3:C7:E8:5C:91:70:7F:C0:A1:2A:BC:5D:88:26:67:47:AA:4F:A8:E7:B1:62:F6:33:FF:B3:C9:D9:89:94:76:20", "CloudFlare Origin SSL Certificate Authority"],
      [CLOUDFLARE_ORIGIN_CA_ECC_ROOT, "AA:63:69:7A:22:76:4B:67:B2:13:4C:E1:4C:B5:69:0E:A3:36:94:0B:93:98:61:13:F4:95:45:91:78:32:D8:0D", "CloudFlare Origin SSL ECC Certificate Authority"],
    ];
    for (const [pem, fingerprint, ou] of pins) {
      const cert = new X509Certificate(pem);
      const actual = createHash("sha256").update(cert.raw).digest("hex").toUpperCase().replace(/(..)/g, "$1:").slice(0, -1);
      expect(actual).toBe(fingerprint);
      expect(cert.ca).toBe(true);
      expect(cert.subject).toContain(ou);
      expect(cert.verify(cert.publicKey)).toBe(true); // self-signed root
    }
  });
});

describe("Origin CA chain verification", () => {
  it("verifies a one-hop chain (leaf → anchor — the real Origin CA topology)", () => {
    expect(verifyOriginCaChain(CERT_PEM, [ROOT_PEM])).toBe(true);
  });

  it("verifies a two-hop chain when the blob embeds its intermediate (leaf → intermediate → anchor)", () => {
    const blob = `${CERT_PEM}\n${INTERMEDIATE_PEM}`;
    // The intermediate ALONE is not an anchor; the path must walk through it.
    expect(verifyOriginCaChain(INTERMEDIATE_PEM, [ROOT_PEM])).toBe(true);
    expect(verifyOriginCaChain(blob, [ROOT_PEM])).toBe(true);
  });

  it("rejects when no anchor is reachable (impostor CA, same display text)", () => {
    expect(verifyOriginCaChain(IMPOSTOR_PEM, [ROOT_PEM])).toBe(false);
    expect(verifyOriginCaChain(SELF_SIGNED_PEM, [ROOT_PEM])).toBe(false);
  });

  it("refuses a NON-CA certificate acting as an intermediate (agrees with OpenSSL's verdict)", async () => {
    const blob = `${NONCA_LEAF_PEM}\n${NONCA_PEM}`; // child + its non-CA "issuer"
    expect(verifyOriginCaChain(blob, [ROOT_PEM])).toBe(false);
    // The two validators agree: OpenSSL rejects the same chain (key usage /
    // basic constraints), so our verifier never accepts what the reference
    // implementation calls an invalid CA certificate.
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const FIXTURES_PATH = new URL("../../../../test/fixtures/", import.meta.url).pathname;
    const run = promisify(execFile);
    await expect(
      run("openssl", [
        "verify", "-CAfile", `${FIXTURES_PATH}test-root.pem`,
        "-untrusted", `${FIXTURES_PATH}nonca-cert.pem`,
        `${FIXTURES_PATH}leaf-signed-by-nonca.pem`,
      ]),
    ).rejects.toThrow();
  });

  it("refuses an EXPIRED intermediate in the path", () => {
    const blob = `${LEAF_UNDER_EXPIRED_PEM}\n${EXPIRED_INTERMEDIATE_PEM}`;
    expect(verifyOriginCaChain(blob, [ROOT_PEM])).toBe(false);
  });

  it("rejects unparsable or empty blobs", () => {
    expect(verifyOriginCaChain("garbage", [ROOT_PEM])).toBe(false);
    expect(verifyOriginCaChain(CERT_PEM, [])).toBe(false);
  });

  it("the REAL bundled anchors reject the test-chain certificates (text mimicry does not cross stores)", () => {
    // The intermediate deliberately mimics Cloudflare's names but chains to the
    // test root — the default store must not trust it.
    expect(verifyOriginCaChain(CERT_PEM)).toBe(false);
  });
});

describe("Origin CA certificate validation", () => {
  it("accepts a chained certificate: hostname covered, key paired, live, trusted", () => {
    const result = validateOriginCaCertificate(CERT_PEM, { hostname: "site.example.com", publicKeyPem: KEY_PEM }, { trustAnchors: [ROOT_PEM] });
    expect(result.hostnames).toContain("site.example.com");
    expect(result.fingerprint).toMatch(/^([0-9a-f]{2}:)+[0-9a-f]{2}$/i); // node's SHA-256 fingerprint form
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("rejects an untrusted certificate EVEN THOUGH its issuer text says Cloudflare Origin CA", () => {
    for (const pem of [IMPOSTOR_PEM, SELF_SIGNED_PEM]) {
      try {
        validateOriginCaCertificate(pem, { hostname: "site.example.com", publicKeyPem: KEY_PEM }, { trustAnchors: [ROOT_PEM] });
        expect.unreachable("trust gate must fire before hostname/key checks");
      } catch (error) {
        expect(error).toBeInstanceOf(OriginCaCertificateInvalidError);
        expect((error as OriginCaCertificateInvalidError).code).toBe("ORIGIN_CA_CERT_INVALID");
        expect((error as OriginCaCertificateInvalidError).message).toContain("not issued by a trusted Cloudflare Origin CA root");
      }
    }
  });

  it("rejects a certificate that does not cover the requested hostname", () => {
    expect(() =>
      validateOriginCaCertificate(WRONG_HOST_PEM, { hostname: "site.example.com", publicKeyPem: KEY_PEM }, { trustAnchors: [ROOT_PEM] }),
    ).toThrow(OriginCaCertificateInvalidError);
    try {
      validateOriginCaCertificate(WRONG_HOST_PEM, { hostname: "site.example.com", publicKeyPem: KEY_PEM }, { trustAnchors: [ROOT_PEM] });
    } catch (error) {
      expect((error as OriginCaCertificateInvalidError).code).toBe("ORIGIN_CA_CERT_INVALID");
      expect((error as OriginCaCertificateInvalidError).message).toContain("does not cover site.example.com");
    }
  });

  it("rejects a certificate whose public key does not pair with the pending private key", () => {
    const other = generateOriginCaKey(); // a real, different RSA key
    expect(() =>
      validateOriginCaCertificate(CERT_PEM, { hostname: "site.example.com", publicKeyPem: other.publicKeyPem }, { trustAnchors: [ROOT_PEM] }),
    ).toThrow(/public key does not match/);
  });

  it("rejects an expired certificate (validity window must be live)", () => {
    expect(() =>
      validateOriginCaCertificate(EXPIRED_PEM, { hostname: "site.example.com", publicKeyPem: KEY_PEM }, { trustAnchors: [ROOT_PEM] }),
    ).toThrow(/already expired/);
  });

  it("rejects a non-certificate body entirely", () => {
    expect(() =>
      validateOriginCaCertificate("not a certificate at all", { hostname: "site.example.com", publicKeyPem: KEY_PEM }, { trustAnchors: [ROOT_PEM] }),
    ).toThrow(/not a parsable/);
  });
});
