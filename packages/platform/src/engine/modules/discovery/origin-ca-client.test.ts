import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The Origin CA client's wire behavior: the list endpoint is called with the
 * REQUIRED zone_id and the endpoint's per_page cap (50 — not the shared
 * helper's 100), and every response is normalized from Cloudflare's
 * snake_case (revoked_at → revokedAt, expires_on → expiresOn) so downstream
 * filters cannot silently match nothing.
 */
const request = vi.hoisted(() => vi.fn());
vi.mock("../../lib/cloudflare-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/cloudflare-api")>();
  return { ...actual, cloudflareRequest: request };
});

import { listOriginCaCertificates, normalizeOriginCaCertificate } from "./origin-ca-client";

afterEach(() => {
  request.mockReset();
});

describe("listOriginCaCertificates", () => {
  it("passes the persisted zone_id and per_page=50 — never the shared helper's 100", async () => {
    request.mockResolvedValueOnce({ success: true, result: [{ id: "c1" }] });
    const certs = await listOriginCaCertificates("tok", "zone_abc");
    expect(certs.map((c) => c.id)).toEqual(["c1"]);
    const url = request.mock.calls[0]![1] as string;
    expect(url).toContain("/certificates?zone_id=zone_abc&");
    expect(url).toContain("per_page=50");
    expect(url).not.toContain("per_page=100");
    expect(url).toContain("page=1");
  });

  it("paginates until a short page, normalizing every row", async () => {
    request
      .mockResolvedValueOnce({
        success: true,
        result: [{ id: "c1", revoked_at: "2026-06-01T00:00:00Z" }, ...Array.from({ length: 49 }, (_, i) => ({ id: `filler-${i}` }))],
        result_info: { total_pages: 2, page: 1 },
      })
      .mockResolvedValueOnce({
        success: true,
        result: [{ id: "c2", expires_on: "2030-01-01", hostnames: ["site.example.com"] }], // short page → terminal
        result_info: { total_pages: 2, page: 2 },
      });
    const certs = await listOriginCaCertificates("tok", "zone_abc");
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]![1] as string).toContain("page=2");
    expect(certs[0]).toEqual({ id: "c1", certificate: undefined, hostnames: undefined, expiresOn: undefined, revokedAt: "2026-06-01T00:00:00Z", createdAt: undefined });
    expect(certs[50]).toEqual({ id: "c2", certificate: undefined, hostnames: ["site.example.com"], expiresOn: "2030-01-01", revokedAt: undefined, createdAt: undefined });
  });

  it("stops at total_pages even when the final page is full", async () => {
    request
      .mockResolvedValueOnce({
        success: true,
        result: Array.from({ length: 50 }, (_, i) => ({ id: `p1-${i}` })),
        result_info: { total_pages: 1, page: 1 },
      });
    const certs = await listOriginCaCertificates("tok", "zone_abc");
    expect(request).toHaveBeenCalledTimes(1);
    expect(certs).toHaveLength(50);
  });
});

describe("normalizeOriginCaCertificate", () => {
  it("maps snake_case wire fields to camelCase and drops everything else", () => {
    const normalized = normalizeOriginCaCertificate({
      id: "cert_1",
      certificate: "-----BEGIN CERTIFICATE-----",
      hostnames: ["site.example.com", 42], // non-strings are filtered, not coerced
      expires_on: "2030-01-01",
      revoked_at: null,
      created_on: "2026-01-01",
      requested_validity: 3650,
      request_type: "origin-rsa",
      csr: "should-not-leak-into-our-model",
    });
    expect(normalized).toEqual({
      id: "cert_1",
      certificate: "-----BEGIN CERTIFICATE-----",
      hostnames: ["site.example.com"],
      expiresOn: "2030-01-01",
      revokedAt: undefined, // null revoked_at → undefined (not revoked)
      createdAt: "2026-01-01",
    });
  });
});
