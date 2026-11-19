/**
 * Origin CA chain verification (plan §3: "Validate the certificate … as
 * Cloudflare signs it"). A certificate is trusted ONLY when its signature
 * path terminates at one of the bundled Cloudflare Origin CA roots — the
 * issuer's textual identity proves nothing (anyone can write
 * "Cloudflare Origin CA" in an issuer string).
 *
 * Verification is pairwise signature checks with node:crypto's
 * X509Certificate.verify(): leaf → (any embedded intermediates) → anchor.
 * Bounded: at most 10 certificates in a blob and depth 4 — this is a
 * one-hop chain in practice; anything deeper is not an Origin CA chain.
 */
import { X509Certificate } from "node:crypto";
import { ORIGIN_CA_TRUST_ANCHORS } from "./origin-ca-trust-roots";

const MAX_BLOB_CERTIFICATES = 10;
const MAX_CHAIN_DEPTH = 4;

/** Split a PEM blob (possibly leaf + intermediates) into parsed certificates. */
function parseCertificates(pem: string): X509Certificate[] {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  if (blocks.length === 0 || blocks.length > MAX_BLOB_CERTIFICATES) return [];
  const parsed: X509Certificate[] = [];
  for (const block of blocks) {
    try {
      parsed.push(new X509Certificate(block));
    } catch {
      return []; // an unreadable segment is not verifiable material
    }
  }
  return parsed;
}

function sameCertificate(a: X509Certificate, b: X509Certificate): boolean {
  return a.fingerprint256 === b.fingerprint256;
}

/**
 * A certificate may act as an ISSUER in a trust path only if it is a live CA
 * whose key usage allows certificate signing. Checking bare signatures lets a
 * leaf-to-leaf chain impersonate a path to trust (OpenSSL rejects these with
 * "invalid CA certificate" — so do we). BasicConstraints is the binding
 * constraint; keyUsage is enforced only when the extension is present.
 */
function canActAsIssuer(cert: X509Certificate, now: number): boolean {
  if (!cert.ca) return false;
  const usage = cert.keyUsage as readonly string[] | undefined | null;
  if (usage && !usage.includes("keyCertSign")) return false;
  const validFrom = new Date(cert.validFrom).getTime();
  const validTo = new Date(cert.validTo).getTime();
  return Number.isFinite(validFrom) && Number.isFinite(validTo) && validFrom <= now && now <= validTo;
}

/**
 * True when the FIRST certificate in `pem` carries a signature path to one of
 * `anchors` (default: the bundled Cloudflare Origin CA roots). The remaining
 * certificates in the blob may serve as intermediates — but only live CAs
 * with signing key usage may sit between the leaf and the anchor.
 */
export function verifyOriginCaChain(
  pem: string,
  anchors: readonly string[] = ORIGIN_CA_TRUST_ANCHORS,
): boolean {
  const certificates = parseCertificates(pem);
  if (certificates.length === 0) return false;
  const anchorCerts = parseCertificates(anchors.join("\n"));
  if (anchorCerts.length === 0) return false;
  const intermediates = certificates.slice(1);
  const now = Date.now();

  const walksToAnchor = (cert: X509Certificate, depth: number, pool: X509Certificate[]): boolean => {
    if (depth > MAX_CHAIN_DEPTH) return false;
    for (const anchor of anchorCerts) {
      if (sameCertificate(cert, anchor)) return true;
      if (canActAsIssuer(anchor, now) && cert.verify(anchor.publicKey) && cert.issuer === anchor.subject) return true;
    }
    for (const candidate of pool) {
      if (sameCertificate(candidate, cert)) continue;
      if (!canActAsIssuer(candidate, now)) continue; // a leaf can never be an intermediate
      if (cert.verify(candidate.publicKey) && cert.issuer === candidate.subject) {
        if (walksToAnchor(candidate, depth + 1, pool.filter((c) => !sameCertificate(c, candidate)))) return true;
      }
    }
    return false;
  };

  return walksToAnchor(certificates[0]!, 0, [...intermediates]);
}
