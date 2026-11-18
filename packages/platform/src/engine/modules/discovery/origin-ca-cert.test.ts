import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateOriginCaKey } from "./origin-ca-csr";
import { OriginCaCertificateInvalidError, validateOriginCaCertificate } from "./origin-ca-cert";

/**
 * Origin CA certificate validation: hostname coverage, public-key pairing,
 * live validity, and the structural issuer gate — every rejection path must
 * fire BEFORE a candidate is ever stored or installed.
 */
const CERT_PEM = readFileSync(new URL("../../../../test/fixtures/test-cert.pem", import.meta.url), "utf8"); // CN/SAN: site.example.com, O=Cloudflare Origin CA
const KEY_PEM = readFileSync(new URL("../../../../test/fixtures/test-key.pem", import.meta.url), "utf8"); // the fixture's own private key
const WRONG_ISSUER_PEM = readFileSync(new URL("../../../../test/fixtures/other-issuer-cert.pem", import.meta.url), "utf8"); // O=Let's Encrypt

describe("Origin CA certificate validation", () => {
  it("accepts the fixture: hostname covered, key paired, live, Origin CA issuer", () => {
    const result = validateOriginCaCertificate(CERT_PEM, { hostname: "site.example.com", publicKeyPem: KEY_PEM });
    expect(result.hostnames).toContain("site.example.com");
    expect(result.fingerprint).toMatch(/^([0-9a-f]{2}:)+[0-9a-f]{2}$/i); // node's SHA-256 fingerprint form
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("rejects a certificate that does not cover the requested hostname", () => {
    expect(() =>
      validateOriginCaCertificate(CERT_PEM, { hostname: "other.example.com", publicKeyPem: KEY_PEM }),
    ).toThrow(OriginCaCertificateInvalidError);
    try {
      validateOriginCaCertificate(CERT_PEM, { hostname: "other.example.com", publicKeyPem: KEY_PEM });
    } catch (error) {
      expect((error as OriginCaCertificateInvalidError).code).toBe("ORIGIN_CA_CERT_INVALID");
    }
  });

  it("rejects a certificate whose public key does not pair with the pending private key", () => {
    const other = generateOriginCaKey(); // a real, different RSA key
    expect(() =>
      validateOriginCaCertificate(CERT_PEM, { hostname: "site.example.com", publicKeyPem: other.publicKeyPem }),
    ).toThrow(/public key does not match/);
  });

  it("rejects a non-Certificate body entirely", () => {
    expect(() =>
      validateOriginCaCertificate("not a certificate at all", { hostname: "site.example.com", publicKeyPem: KEY_PEM }),
    ).toThrow(/not a parsable/);
  });

  it("rejects an issuer that is not a Cloudflare Origin CA issuer (display string is a gate, not proof)", () => {
    expect(() =>
      validateOriginCaCertificate(WRONG_ISSUER_PEM, { hostname: "site.example.com", publicKeyPem: KEY_PEM }),
    ).toThrow(/issuer is not a Cloudflare Origin CA/);
  });
});
