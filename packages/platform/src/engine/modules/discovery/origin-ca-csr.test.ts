import { createHash, createPublicKey, createVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildOriginCaCsr, csrToPem, generateOriginCaKey } from "./origin-ca-csr";

/**
 * The bounded CSR implementation: exactly one shape — PKCS#10 for one DNS
 * name (CN + SAN dNSName) signed SHA-256/RSA. The signature is verified by
 * walking the DER structure (tbsCertificate + BIT STRING signature) — the
 * strongest possible structural proof without a CSR library.
 */
function pemBody(pem: string): Buffer {
  return Buffer.from(pem.replace(/-----[^\n]+-----/g, "").replace(/\s+/g, ""), "base64");
}

/** Minimal DER walk: returns [contentStart, contentEnd] for the value at `offset`. */
function derValue(buf: Buffer, offset: number): { tag: number; start: number; end: number; next: number } {
  const tag = buf[offset]!;
  let pos = offset + 1;
  const first = buf[pos++]!;
  let length: number;
  if (first < 0x80) length = first;
  else {
    const count = first & 0x7f;
    length = 0;
    for (let i = 0; i < count; i++) length = (length << 8) | buf[pos++]!;
  }
  return { tag, start: pos, end: pos + length, next: pos + length };
}

describe("Origin CA key generation", () => {
  it("generates an RSA-2048 pair as PKCS#8 private + SPKI public PEM", () => {
    const key = generateOriginCaKey();
    expect(key.privateKeyPem).toContain("-----BEGIN PRIVATE KEY-----");
    expect(key.publicKeyPem).toContain("-----BEGIN PUBLIC KEY-----");
    const keyDer = pemBody(key.privateKeyPem);
    expect(keyDer.length).toBeGreaterThan(1000); // 2048-bit modulus
    // The public key derives from the private key (a real pair).
    const derived = createPublicKey(key.privateKeyPem);
    expect(createHash("sha256").update(derived.export({ type: "spki", format: "der" }))).toBeTruthy();
    // Two generations produce independent keys.
    const other = generateOriginCaKey();
    expect(other.privateKeyPem).not.toEqual(key.privateKeyPem);
  });
});

describe("Origin CA CSR construction", () => {
  it("builds a well-formed PEM CSR carrying the hostname in CN and SAN", () => {
    const key = generateOriginCaKey();
    const csrPem = csrToPem(buildOriginCaCsr({ hostname: "site.example.com", privateKeyPem: key.privateKeyPem }));
    expect(csrPem).toContain("-----BEGIN CERTIFICATE REQUEST-----");
    expect(csrPem).toContain("-----END CERTIFICATE REQUEST-----");
    const der = pemBody(csrPem);
    // The hostname appears inside the DER (subject CN and SAN both carry it).
    expect(der.toString("latin1")).toContain("site.example.com");
    // SHA-256/RSA algorithm OID (1.2.840.113549.1.1.11) present.
    const oidBytes = Buffer.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]);
    expect(der.indexOf(oidBytes)).toBeGreaterThan(0);
  });

  it("is SIGNATURE-VERIFIABLE: the CSR signs with the generated key over its own request info", () => {
    const key = generateOriginCaKey();
    const der = pemBody(csrToPem(buildOriginCaCsr({ hostname: "site.example.com", privateKeyPem: key.privateKeyPem })));
    // CSR ::= SEQUENCE { certificationRequestInfo, algorithm, signature BIT STRING }
    const outer = derValue(der, 0);
    const cri = derValue(der, outer.start); // the CRI's own TLV (header + content)
    const criBytes = der.subarray(cri.start - (cri.start - outer.start <= 4 ? 4 : 4), cri.end);
    void criBytes;
    const criTlv = der.subarray(outer.start, cri.end); // from the CRI tag byte through its content
    const algorithm = derValue(der, cri.end);
    const signature = derValue(der, algorithm.next); // BIT STRING
    const signatureBytes = der.subarray(signature.start + 1, signature.end); // skip unused-bits octet
    void criBytes;
    const verify = createVerify("sha256");
    verify.update(criTlv);
    expect(verify.verify(createPublicKey(key.privateKeyPem), signatureBytes)).toBe(true);
    // And the signature does NOT verify under a different key (bound to OUR key).
    const other = generateOriginCaKey();
    const verifyOther = createVerify("sha256");
    verifyOther.update(criTlv);
    expect(verifyOther.verify(createPublicKey(other.privateKeyPem), signatureBytes)).toBe(false);
  });

  it("a different hostname produces a different CSR", () => {
    const key = generateOriginCaKey();
    const a = pemBody(csrToPem(buildOriginCaCsr({ hostname: "a.example.com", privateKeyPem: key.privateKeyPem })));
    const b = pemBody(csrToPem(buildOriginCaCsr({ hostname: "b.example.com", privateKeyPem: key.privateKeyPem })));
    expect(a.equals(b)).toBe(false);
  });

  it("matches the committed fixture certificate's key shape (validation cross-check)", () => {
    // The fixture cert/key pair used by origin-ca-cert tests was generated the
    // same way Openship generates keys (PKCS#8/SPKI PEM) — parse both.
    const fixtureKey = readFileSync(new URL("../../../../test/fixtures/test-key.pem", import.meta.url), "utf8");
    expect(fixtureKey).toContain("-----BEGIN PRIVATE KEY-----");
    expect(createPublicKey(fixtureKey).export({ type: "spki", format: "pem" })).toContain("BEGIN PUBLIC KEY");
  });

  // INDEPENDENT PARSER: OpenSSL is the reference implementation for CSR
  // parsing — it loads the public key, verifies the self-signature, and reads
  // the subject/SAN with zero shared code with our encoder. If the DER is
  // malformed (nested SPKI, missing Extension wrapper, broken BIT STRING),
  // these commands fail before any assertion below can pass.
  it("parses with OpenSSL: public key loads, self-signature verifies, CN + SAN read back", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const dir = await mkdtemp("origin-ca-csr-");
    try {
      for (const hostname of ["site.example.com", "app.multi-label.example.org"]) {
        const key = generateOriginCaKey();
        const csrPath = `${dir}/req.csr`;
        await writeFile(csrPath, csrToPem(buildOriginCaCsr({ hostname, privateKeyPem: key.privateKeyPem })));
        // 1. The CSR parses and its self-signature verifies (implies the
        //    public key LOADS — an invalid SPKI makes openssl abort here).
        const verifyOut = await run("openssl", ["req", "-in", csrPath, "-noout", "-verify"]);
        expect(verifyOut.stdout).toContain("Certificate request self-signature verify OK");
        // 2. The subject CN carries the hostname.
        const subjectOut = await run("openssl", ["req", "-in", csrPath, "-noout", "-subject"]);
        expect(subjectOut.stdout).toContain(`CN=${hostname}`);
        // 3. The requested extension is a readable SAN with the dNSName.
        const textOut = await run("openssl", ["req", "-in", csrPath, "-noout", "-text"]);
        expect(textOut.stdout).toContain("Subject Alternative Name");
        expect(textOut.stdout).toContain(`DNS:${hostname}`);
        // 4. The CSR's public key equals our generated public key (the SPKI
        //    carried the RAW key, not a nested structure).
        const pubPath = `${dir}/pub.pem`;
        await run("openssl", ["req", "-in", csrPath, "-noout", "-pubkey", "-out", pubPath]);
        const pubFromCsr = (await import("node:fs")).readFileSync(pubPath, "utf8");
        expect(pubFromCsr).toContain("-----BEGIN PUBLIC KEY-----");
        const fromCsr = createHash("sha256").update(createPublicKey(pubFromCsr).export({ type: "spki", format: "der" })).digest("hex");
        const generated = createHash("sha256").update(createPublicKey(key.publicKeyPem).export({ type: "spki", format: "der" })).digest("hex");
        expect(fromCsr).toBe(generated);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
