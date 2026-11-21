/**
 * Origin CA key generation and CSR construction (plan §3: "Generate the
 * private key and CSR within Openship using established crypto helpers (or a
 * bounded crypto implementation chosen during implementation)").
 *
 * No CSR library exists in this dependency tree, so the CSR is a BOUNDED,
 * hand-rolled DER encoder: exactly one shape — a PKCS#10 CertificationRequest
 * for one DNS name (CN + SAN dNSName via extensionRequest) signed with
 * SHA-256/RSA. Nothing else can be encoded, and the private key NEVER leaves
 * the process except through the encrypted persistence envelope.
 *
 * RSA 2048 (the plan's proposed default) via node:crypto; the CSR carries the
 * public key, the SAN, and nothing else — no private material, no challenge
 * passwords, no extra attributes.
 */
import { createPublicKey, createSign, generateKeyPairSync } from "node:crypto";

export interface OriginCaKeyMaterial {
  /** PKCS#8 PEM — the ENCRYPTED-AT-REST private key (never logged, never returned). */
  privateKeyPem: string;
  /** SPKI PEM — public key (safe; travels inside the CSR anyway). */
  publicKeyPem: string;
}

export function generateOriginCaKey(): OriginCaKeyMaterial {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { privateKeyPem: privateKey, publicKeyPem: publicKey };
}

// ── Bounded DER encoding (exactly the CSR shape; nothing general-purpose) ────

function derLength(length: number): Uint8Array {
  if (length < 0x80) return new Uint8Array([length]);
  const bytes: number[] = [];
  let rest = length;
  while (rest > 0) {
    bytes.unshift(rest & 0xff);
    rest >>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function der(tag: number, ...content: Uint8Array[]): Uint8Array {
  const body = content.reduce((acc, part) => {
    const merged = new Uint8Array(acc.length + part.length);
    merged.set(acc, 0);
    merged.set(part, acc.length);
    return merged;
  }, new Uint8Array(0));
  const out = new Uint8Array(1 + derLength(body.length).length + body.length);
  out[0] = tag;
  out.set(derLength(body.length), 1);
  out.set(body, 1 + derLength(body.length).length);
  return out;
}

function derSequence(...parts: Uint8Array[]): Uint8Array {
  return der(0x30, ...parts);
}

function derSet(...parts: Uint8Array[]): Uint8Array {
  return der(0x31, ...parts);
}

function derInteger(value: number): Uint8Array {
  return der(0x02, new Uint8Array([value]));
}

function derUtf8String(text: string): Uint8Array {
  return der(0x0c, new TextEncoder().encode(text));
}

function derOid(oid: string): Uint8Array {
  const parts = oid.split(".").map((part) => Number.parseInt(part, 10));
  const body: number[] = [parts[0]! * 40 + parts[1]!];
  for (const part of parts.slice(2)) {
    let rest = part;
    const encoded: number[] = [rest & 0x7f];
    rest >>= 7;
    while (rest > 0) {
      encoded.unshift(0x80 | (rest & 0x7f));
      rest >>= 7;
    }
    body.push(...encoded);
  }
  return der(0x06, new Uint8Array(body));
}

function derBitString(content: Uint8Array): Uint8Array {
  // Leading zero octet: BIT STRING counts unused bits (DER requires 0 here).
  // The content is RAW bytes — never TLV-spread (spreading would wrap every
  // byte as its own element and corrupt the structure).
  return der(0x03, new Uint8Array([0]), content);
}

function derOctetString(...content: Uint8Array[]): Uint8Array {
  return der(0x04, ...content);
}

function derContextTag(tagNumber: number, ...content: Uint8Array[]): Uint8Array {
  return der(0xa0 | tagNumber, ...content);
}

/** Minimal bounded DER TLV reader — just enough to strip the SPKI shell. */
function readDerTlv(
  bytes: Uint8Array,
  offset: number,
): { tag: number; contentStart: number; contentEnd: number; next: number } {
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

const OID_SHA256_RSA = "1.2.840.113549.1.1.11";
const OID_COMMON_NAME = "2.5.4.3";
const OID_EXTENSION_REQUEST = "1.2.840.113549.1.9.14";
const OID_SUBJECT_ALT_NAME = "2.5.29.17";
const OID_RSA_ENCRYPTION = "1.2.840.113549.1.1.1";

function algorithmIdentifier(): Uint8Array {
  return derSequence(derOid(OID_SHA256_RSA), der(0x05));
}

/** SPKI DER extracted from an SPKI PEM (strip armor, base64-decode). */
function spkiDerFromPem(publicKeyPem: string): Uint8Array {
  const body = publicKeyPem
    .replace(/-----BEGIN PUBLIC KEY-----/, "")
    .replace(/-----END PUBLIC KEY-----/, "")
    .replace(/\s+/g, "");
  return new Uint8Array(Buffer.from(body, "base64"));
}

/** The RAW RSA public key DER (SEQUENCE { INTEGER n, INTEGER e }). The SPKI
 *  PEM wraps key || algorithm — the CSR's BIT STRING must carry ONLY the key
 *  itself, NOT the enclosing SPKI (nesting the SPKI here produces an invalid
 *  public key that OpenSSL refuses to load). */
function rawPublicKeyFromSpkiDer(spki: Uint8Array): Uint8Array {
  const spkiTlv = readDerTlv(spki, 0); // SEQUENCE — the outer SPKI shell
  if (spkiTlv.tag !== 0x30) throw new Error("Unexpected public key structure");
  const algId = readDerTlv(spki, spkiTlv.contentStart); // child 1: AlgorithmIdentifier
  const bitString = readDerTlv(spki, algId.next); // child 2: BIT STRING
  if (bitString.tag !== 0x03) throw new Error("Unexpected public key structure");
  if (spki[bitString.contentStart] !== 0) throw new Error("Unexpected public key padding");
  return spki.slice(bitString.contentStart + 1, bitString.contentEnd);
}

/**
 * Build a DER-encoded PKCS#10 CSR for `hostname` signed by `privateKeyPem`.
 * Subject: CN=<hostname> (O=Openship Discovery). Requested extension: SAN
 * dNSName=<hostname> via extensionRequest — Cloudflare's Origin CA reads the
 * authorized hostnames from the CSR, so the SAN and the CN agree exactly.
 */
export function buildOriginCaCsr(input: { hostname: string; privateKeyPem: string }): Uint8Array {
  const hostname = input.hostname.toLowerCase().replace(/\.$/, "");
  // The SPKI DER is derived from the private key itself — no separate public
  // parameter to keep consistent.
  const publicKeyPem = createPublicKey(input.privateKeyPem).export({ type: "spki", format: "pem" }).toString();
  const publicKeyInfo = derSequence(
    derSequence(derOid(OID_RSA_ENCRYPTION), der(0x05)),
    derBitString(rawPublicKeyFromSpkiDer(spkiDerFromPem(publicKeyPem))),
  );
  const subject = derSequence(derSet(derSequence(derOid(OID_COMMON_NAME), derUtf8String(hostname))));
  // Extension = SEQUENCE { extnID OID, extnValue OCTET STRING { SAN DER } };
  // the extnValue CONTAINS the DER of a SEQUENCE OF GeneralNames (the dNSName
  // is the context tag [2] IMPLICIT IA5String).
  const sanExtension = derSequence(
    derOid(OID_SUBJECT_ALT_NAME),
    derOctetString(derSequence(der(0x82, new TextEncoder().encode(hostname)))),
  );
  // extensionRequest's SET value is a SEQUENCE OF Extension — the Extension
  // itself must be WRAPPED in that sequence.
  const attributes = derContextTag(
    0,
    derSequence(derOid(OID_EXTENSION_REQUEST), derSet(derSequence(sanExtension))),
  );
  const certificationRequestInfo = derSequence(
    derInteger(0),
    subject,
    publicKeyInfo,
    attributes,
  );
  const signer = createSign("sha256");
  signer.update(certificationRequestInfo);
  const signature = signer.sign(input.privateKeyPem);
  return derSequence(certificationRequestInfo, algorithmIdentifier(), derBitString(signature));
}

/** PEM armor for an already-DER-encoded CSR (the API takes PEM). */
export function csrToPem(der: Uint8Array): string {
  const body = Buffer.from(der).toString("base64");
  const lines = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE REQUEST-----\n${lines.join("\n")}\n-----END CERTIFICATE REQUEST-----\n`;
}
