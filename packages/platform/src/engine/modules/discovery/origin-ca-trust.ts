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
 * True when the FIRST certificate in `pem` carries a signature path to one of
 * `anchors` (default: the bundled Cloudflare Origin CA roots). The remaining
 * certificates in the blob may serve as intermediates.
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

  const walksToAnchor = (cert: X509Certificate, depth: number, pool: X509Certificate[]): boolean => {
    if (depth > MAX_CHAIN_DEPTH) return false;
    for (const anchor of anchorCerts) {
      if (sameCertificate(cert, anchor)) return true;
      if (cert.verify(anchor.publicKey) && cert.issuer === anchor.subject) return true;
    }
    for (const candidate of pool) {
      if (sameCertificate(candidate, cert)) continue;
      if (cert.verify(candidate.publicKey) && cert.issuer === candidate.subject) {
        if (walksToAnchor(candidate, depth + 1, pool.filter((c) => !sameCertificate(c, candidate)))) return true;
      }
    }
    return false;
  };

  return walksToAnchor(certificates[0]!, 0, [...intermediates]);
}
