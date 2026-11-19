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

// ── Plain KeyUsage parsing (the property node:crypto exposes is NOT this) ──
// X509Certificate.keyUsage on modern Node returns EXTENDED key usage OIDs
// (e.g. "1.3.6.1.5.5.7.3.1" for serverAuth) and can be undefined even when a
// plain KeyUsage extension exists — it cannot answer "may this CA sign
// certificates?". The KeyUsage BIT STRING is therefore read from the raw DER:
// Certificate → tbsCertificate → [3] extensions → extension OID 2.5.29.15.

interface DerTlv {
  tag: number;
  contentStart: number;
  contentEnd: number;
  next: number;
}

function readTlv(bytes: Uint8Array, offset: number): DerTlv {
  const tag = bytes[offset]!;
  let pos = offset + 1;
  let length = bytes[pos]!;
  pos += 1;
  if (length & 0x80) {
    const count = length & 0x7f;
    length = 0;
    for (let i = 0; i < count; i++) {
      length = (length << 8) | bytes[pos]!;
      pos += 1;
    }
  }
  return { tag, contentStart: pos, contentEnd: pos + length, next: pos + length };
}

const KEY_USAGE_OID = new Uint8Array([0x55, 0x1d, 0x0f]); // 2.5.29.15
const KEY_CERT_SIGN_BIT = 5; // bit 0 = digitalSignature … bit 5 = keyCertSign

/**
 * The plain KeyUsage BIT STRING payload ([unused-bits octet, then bits]) or:
 *   null  → the certificate carries NO KeyUsage extension (no constraint),
 *   undefined → the DER structure could not be parsed (fail closed).
 */
/**
 * The plain KeyUsage BIT STRING payload ([unused-bits octet, then bits]) or:
 *   null  → the certificate carries NO KeyUsage extension (no constraint),
 *   undefined → the DER structure could not be parsed (fail closed).
 * Exported for tests — node:crypto's keyUsage property exposes EXTENDED
 * usages and misses the plain extension entirely, so this reader is the
 * version-independent authority.
 */
export function plainKeyUsageBits(cert: X509Certificate): Uint8Array | null | undefined {
  return readPlainKeyUsage(cert.raw);
}

function readPlainKeyUsage(certDer: Uint8Array): Uint8Array | null | undefined {
  try {
    const outer = readTlv(certDer, 0);
    if (outer.tag !== 0x30) return undefined;
    const tbs = readTlv(certDer, outer.contentStart); // first child: tbsCertificate
    if (tbs.tag !== 0x30) return undefined;
    let pos = tbs.contentStart;
    let extensions: DerTlv | undefined;
    while (pos < tbs.contentEnd) {
      const child = readTlv(certDer, pos);
      if (child.tag === 0xa3) {
        extensions = child; // [3] EXPLICIT extensions
        break;
      }
      pos = child.next;
    }
    if (!extensions) return null; // no extensions at all — no KeyUsage constraint
    const sequence = readTlv(certDer, extensions.contentStart);
    if (sequence.tag !== 0x30) return undefined;
    let cursor = sequence.contentStart;
    while (cursor < sequence.contentEnd) {
      const extension = readTlv(certDer, cursor); // Extension SEQUENCE
      if (extension.tag !== 0x30) return undefined;
      const oid = readTlv(certDer, extension.contentStart);
      if (oid.tag !== 0x06) return undefined;
      const oidBytes = certDer.slice(oid.contentStart, oid.contentEnd);
      let value = readTlv(certDer, oid.next);
      if (value.tag === 0x01) value = readTlv(certDer, value.next); // skip critical BOOL
      if (
        oidBytes.length === KEY_USAGE_OID.length &&
        oidBytes.every((byte, i) => byte === KEY_USAGE_OID[i]) &&
        value.tag === 0x04
      ) {
        const bitString = readTlv(certDer, value.contentStart); // OCTET STRING wraps BIT STRING
        if (bitString.tag !== 0x03) return undefined;
        return certDer.slice(bitString.contentStart, bitString.contentEnd);
      }
      cursor = extension.next;
    }
    return null; // extensions present, KeyUsage is not one of them
  } catch {
    return undefined;
  }
}

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
 * whose PLAIN KeyUsage allows certificate signing. Extended key usage is
 * deliberately ignored (OpenSSL does not constrain CA signing by EKU — a CA
 * carrying only serverAuth EKU still verifies). BasicConstraints is the
 * binding constraint; KeyUsage is enforced only when the extension is
 * present. Failure to parse the structure fails closed.
 */
function canActAsIssuer(cert: X509Certificate, now: number): boolean {
  if (!cert.ca) return false;
  const keyUsage = readPlainKeyUsage(cert.raw);
  if (keyUsage === undefined) return false; // unreadable DER: cannot establish issuer capability
  if (keyUsage !== null && keyUsage.length >= 1) {
    const firstUsageByte = keyUsage[1]; // keyUsage[0] is the unused-bits octet
    if (firstUsageByte !== undefined && ((firstUsageByte >> (7 - KEY_CERT_SIGN_BIT)) & 1) !== 1) {
      return false;
    }
  }
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
