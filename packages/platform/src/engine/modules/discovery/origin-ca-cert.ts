/**
 * Origin CA certificate validation (plan §3 step 5): a returned certificate is
 * TRUSTED only after structural validation — hostname match, public-key match
 * against the private key we generated, live validity window, and a Cloudflare
 * Origin CA issuer structure. The issuer DISPLAY string alone is not proof of
 * anything; it is checked only as a structural sanity gate alongside the
 * parse itself (a malformed/non-certificate body must be rejected, not stored).
 *
 * Chain validation against Cloudflare's published Origin CA trust roots is a
 * tracked follow-up (the edge's own validation and this structural gate bound
 * the risk until then); every other acceptance criterion here is decisive.
 */
import { createHash, createPublicKey, X509Certificate, type KeyObject } from "node:crypto";
import { AppError } from "@repo/core";

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
): ValidatedOriginCaCertificate {
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(certificatePem);
  } catch {
    throw new OriginCaCertificateInvalidError("the response is not a parsable X.509 certificate");
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

  // Structural issuer gate: Origin CA certificates name Cloudflare's Origin CA
  // organization as issuer. Combined with the parse, this rejects an arbitrary
  // certificate body masquerading as an Origin CA response (it is a sanity
  // gate — chain trust is validated separately at installation, and the edge
  // validates the chain again per connection).
  const issuer = cert.issuer;
  if (!/Cloudflare|Origin CA/i.test(issuer)) {
    throw new OriginCaCertificateInvalidError(`the certificate issuer is not a Cloudflare Origin CA issuer (${issuer.replaceAll("\n", ", ")})`);
  }

  const hostnames = (cert.subjectAltName ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.toLowerCase().startsWith("dns:"))
    .map((entry) => entry.slice(4).toLowerCase());

  return { fingerprint: cert.fingerprint256, expiresAt: new Date(validTo), hostnames };
}
