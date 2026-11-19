/**
 * Origin CA certificate validation (plan §3 step 5): a returned certificate is
 * TRUSTED only after structural validation — hostname match, public-key match
 * against the private key we generated, live validity window, and SIGNATURE
 * VERIFICATION against the trusted Cloudflare Origin CA roots. The issuer
 * display string is NOT consulted at all: anyone can write "Cloudflare Origin
 * CA" in an issuer field, so trust comes exclusively from the verified chain
 * (origin-ca-trust.ts), never from certificate text.
 */
import { createHash, createPublicKey, X509Certificate, type KeyObject } from "node:crypto";
import { AppError } from "@repo/core";
import { verifyOriginCaChain } from "./origin-ca-trust";

export interface ValidatedOriginCaCertificate {
  fingerprint: string;
  expiresAt: Date;
  hostnames: string[];
}

/** Rejected return: the candidate must never be stored or installed. */
export class OriginCaCertificateInvalidError extends AppError {
  constructor(message: string) {
    super(`Cloudflare Origin CA certificate rejected: ${message}`, 502, "ORIGIN_CA_CERT_INVALID");
  }
}

function spkiFingerprint(key: KeyObject | string): string {
  const keyObject = typeof key === "string" ? createPublicKey(key) : key;
  const der = keyObject.export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex");
}

export function validateOriginCaCertificate(
  certificatePem: string,
  expected: { hostname: string; publicKeyPem: string },
  /** Overridable for tests: real roots by default (bundled Cloudflare Origin CA anchors). */
  options: { trustAnchors?: readonly string[] } = {},
): ValidatedOriginCaCertificate {
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(certificatePem);
  } catch {
    throw new OriginCaCertificateInvalidError("the response is not a parsable X.509 certificate");
  }

  // TRUST: the certificate's signature path must terminate at a trusted
  // Cloudflare Origin CA root. This runs FIRST — an untrusted certificate has
  // no business being compared, matched, or stored regardless of its fields.
  if (!verifyOriginCaChain(certificatePem, options.trustAnchors)) {
    throw new OriginCaCertificateInvalidError(
      "the certificate is not issued by a trusted Cloudflare Origin CA root (issuer text is not proof)",
    );
  }

  // Hostname: SAN/CN must cover the hostname we asked for (the CSR's exact name).
  if (!cert.checkHost(expected.hostname)) {
    throw new OriginCaCertificateInvalidError(
      `the certificate does not cover ${expected.hostname} (subjectAltName: ${cert.subjectAltName ?? "none"})`,
    );
  }

  // Key: the certificate's public key MUST be the pair of the private key we
  // generated — a certificate for someone else's key is unusable, and adopting
  // one would strand the domain on material we cannot pair.
  const certKeyFp = spkiFingerprint(cert.publicKey);
  const ourKeyFp = spkiFingerprint(expected.publicKeyPem);
  if (certKeyFp !== ourKeyFp) {
    throw new OriginCaCertificateInvalidError("the certificate's public key does not match the pending private key");
  }

  // Expiry: live now, and a sane duration (Cloudflare issues from issue date).
  const now = Date.now();
  const validFrom = new Date(cert.validFrom).getTime();
  const validTo = new Date(cert.validTo).getTime();
  if (!Number.isFinite(validFrom) || !Number.isFinite(validTo)) {
    throw new OriginCaCertificateInvalidError("the certificate has unparsable validity dates");
  }
  if (validFrom > now) throw new OriginCaCertificateInvalidError("the certificate is not yet valid");
  if (validTo <= now) throw new OriginCaCertificateInvalidError("the certificate is already expired");

  const hostnames = (cert.subjectAltName ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.toLowerCase().startsWith("dns:"))
    .map((entry) => entry.slice(4).toLowerCase());

  return { fingerprint: cert.fingerprint256, expiresAt: new Date(validTo), hostnames };
}
