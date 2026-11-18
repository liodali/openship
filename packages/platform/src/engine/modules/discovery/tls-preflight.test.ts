import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@repo/core";

/**
 * Cloudflare Origin CA preflight (plan §2): read-only checks — zone + credential
 * readability, DNS-label-boundary membership, effective proxied hostname
 * (exact or ancestor wildcard), Full (strict), and configuration-rule
 * overrides reported unresolved. Nothing here mutates anything at Cloudflare.
 */
const cf = vi.hoisted(() => ({
  fetch: vi.fn(),
  list: vi.fn(),
}));

vi.mock("../../lib/cloudflare-api", () => ({
  CloudflareApiError: class CloudflareApiError extends AppError {
    constructor(public providerStatus: number, message: string) {
      super(`Cloudflare: ${message}`, 502, "CLOUDFLARE_API_ERROR");
    }
  },
  cloudflareFetch: cf.fetch,
  cloudflareList: cf.list,
}));

const { preflightCloudflareOriginCa, hostnameInZone, wildcardCandidates } = await import("./tls-preflight");
const { CloudflareApiError } = await import("../../lib/cloudflare-api");
/** A Cloudflare 404 (phase/route absent) as the transport raises it. */
const rulesetMissing = () => new CloudflareApiError(404, "could not be found (404)");

function zoneOk() {
  return { id: "zone_1", name: "example.com", status: "active" };
}
const strict = { value: "strict" };

function zoneResponse(name = "example.com", status = "active") {
  return { id: "zone_1", name, status };
}

beforeEach(() => {
  vi.clearAllMocks();
  cf.fetch.mockImplementation(async (_token: string, path: string) => {
    if (path.startsWith("/zones/zone_1/settings/ssl")) return strict;
    if (path.includes("/rulesets/")) throw rulesetMissing();
    return zoneOk();
  });
  cf.list.mockResolvedValue([{ name: "site.example.com", type: "A", proxied: true }]);
});

describe("zone membership (DNS-label boundary)", () => {
  it("accepts the apex and subdomains, rejects siblings and partial suffixes", () => {
    expect(hostnameInZone("example.com", "example.com")).toBe(true);
    expect(hostnameInZone("site.example.com", "example.com")).toBe(true);
    expect(hostnameInZone("deep.a.example.com", "example.com")).toBe(true);
    expect(hostnameInZone("example.com.", "example.com.")).toBe(true); // trailing dots normalize
    // Sibling suffix: NOT a label boundary — the classic evil-tenant shape.
    expect(hostnameInZone("evilexample.com", "example.com")).toBe(false);
    expect(hostnameInZone("badexample.com", "example.com")).toBe(false);
    expect(hostnameInZone("example.com.evil.io", "example.com")).toBe(false);
    expect(hostnameInZone("other.org", "example.com")).toBe(false);
  });

  it("wildcard candidates walk ancestors only down to the registrable apex", () => {
    expect(wildcardCandidates("a.b.example.com")).toEqual(["*.b.example.com", "*.example.com"]);
    expect(wildcardCandidates("site.example.com")).toEqual(["*.example.com"]);
    expect(wildcardCandidates("example.com")).toEqual([]);
  });

  it("preflight refuses a hostname outside the CONFIGURED zone", async () => {
    await expect(
      preflightCloudflareOriginCa({ apiToken: "tok", zoneId: "zone_1", hostname: "evilexample.com" }),
    ).rejects.toMatchObject({ code: "TLS_ZONE_MEMBERSHIP_INVALID" });
  });

  it("preflight refuses a sibling suffix even when DNS records would exist", async () => {
    cf.list.mockResolvedValue([{ name: "evilexample.com", type: "A", proxied: true }]);
    await expect(
      preflightCloudflareOriginCa({ apiToken: "tok", zoneId: "zone_1", hostname: "evilexample.com" }),
    ).rejects.toMatchObject({ code: "TLS_ZONE_MEMBERSHIP_INVALID" });
  });
});

describe("credential and zone readability", () => {
  it("surfaces Cloudflare API failures (403/404/outage) as retryable 502s — nothing persisted", async () => {
    cf.fetch.mockRejectedValue(
      Object.assign(new AppError("Could not verify token (403)", 502, "CLOUDFLARE_API_ERROR"), { providerStatus: 403 }),
    );
    await expect(
      preflightCloudflareOriginCa({ apiToken: "tok", zoneId: "zone_1", hostname: "site.example.com" }),
    ).rejects.toMatchObject({ statusCode: 502, code: "CLOUDFLARE_API_ERROR" });
  });

  it("reports an unresolvable zone (missing name) as unresolved configuration", async () => {
    cf.fetch.mockImplementation(async (_t: string, path: string) => {
      if (path === "/zones/zone_1") return { id: "zone_1" }; // no name: Zone Read lacking
      return strict;
    });
    await expect(
      preflightCloudflareOriginCa({ apiToken: "tok", zoneId: "zone_1", hostname: "site.example.com" }),
    ).rejects.toMatchObject({ code: "TLS_CONFIGURATION_UNRESOLVED" });
  });

  it("refuses an inactive zone", async () => {
    cf.fetch.mockImplementation(async (_t: string, path: string) =>
      path === "/zones/zone_1" ? zoneResponse("example.com", "pending") : strict,
    );
    await expect(
      preflightCloudflareOriginCa({ apiToken: "tok", zoneId: "zone_1", hostname: "site.example.com" }),
    ).rejects.toMatchObject({ code: "TLS_CONFIGURATION_UNRESOLVED" });
  });
});

describe("proxied DNS (effective hostname)", () => {
  it("accepts an exact proxied record", async () => {
    const result = await preflightCloudflareOriginCa({ apiToken: "tok", zoneId: "zone_1", hostname: "site.example.com" });
    expect(result.zoneName).toBe("example.com"); // VERIFIED through Cloudflare
    expect(cf.list).toHaveBeenCalledWith("tok", expect.stringContaining("dns_records?name=site.example.com"));
  });

  it("accepts a proxied ancestor wildcard DNS record (proxy evidence, not a wildcard certificate)", async () => {
    cf.list.mockImplementation(async (_t: string, path: string) => {
      if (path.includes("name=site.example.com")) return [{ name: "site.example.com", type: "A", proxied: false }];
      if (path.includes("name=*.example.com")) return [{ name: "*.example.com", type: "A", proxied: true }];
      return [];
    });
    await expect(
      preflightCloudflareOriginCa({ apiToken: "tok", zoneId: "zone_1", hostname: "site.example.com" }),
    ).resolves.toMatchObject({ zoneName: "example.com" });
  });

  it("refuses a hostname with no proxied record anywhere (TLS_DNS_NOT_PROXIED)", async () => {
    cf.list.mockResolvedValue([{ name: "site.example.com", type: "A", proxied: false }]);
    await expect(
      preflightCloudflareOriginCa({ apiToken: "tok", zoneId: "zone_1", hostname: "site.example.com" }),
    ).rejects.toMatchObject({ code: "TLS_DNS_NOT_PROXIED" });
  });

  it("non-address records (TXT/NS) never prove proxying", async () => {
    cf.list.mockResolvedValue([{ name: "site.example.com", type: "TXT", proxied: true }]);
    await expect(
      preflightCloudflareOriginCa({ apiToken: "tok", zoneId: "zone_1", hostname: "site.example.com" }),
    ).rejects.toMatchObject({ code: "TLS_DNS_NOT_PROXIED" });
  });
});

describe("Full (strict)", () => {
  it("accepts strict", async () => {
    await expect(
      preflightCloudflareOriginCa({ apiToken: "tok", zoneId: "zone_1", hostname: "site.example.com" }),
    ).resolves.toMatchObject({ zoneName: "example.com" });
  });

  it.each(["full", "flexible", "off"])("refuses %s — it is not Full (strict)", async (mode) => {
    cf.fetch.mockImplementation(async (_t: string, path: string) => {
      if (path.startsWith("/zones/zone_1/settings/ssl")) return { value: mode };
      if (path.includes("/rulesets/")) throw rulesetMissing();
      return zoneOk();
    });
    await expect(
      preflightCloudflareOriginCa({ apiToken: "tok", zoneId: "zone_1", hostname: "site.example.com" }),
    ).rejects.toMatchObject({ code: "TLS_SSL_MODE_UNSUPPORTED" });
  });

  it("an unreadable SSL setting is unresolved, never assumed strict", async () => {
    cf.fetch.mockImplementation(async (_t: string, path: string) => {
      if (path.startsWith("/zones/zone_1/settings/ssl")) throw new AppError("settings read failed", 502, "CLOUDFLARE_API_ERROR");
      if (path.includes("/rulesets/")) throw Object.assign(new AppError("not found", 502, "CLOUDFLARE_API_ERROR"), { providerStatus: 404 });
      return zoneOk();
    });
    await expect(
      preflightCloudflareOriginCa({ apiToken: "tok", zoneId: "zone_1", hostname: "site.example.com" }),
    ).rejects.toMatchObject({ code: "CLOUDFLARE_API_ERROR" });
  });
});

describe("configuration-rule overrides (effective mode provability)", () => {
  it("a ruleset overriding SSL settings is UNRESOLVED — the zone default is not proof", async () => {
    cf.fetch.mockImplementation(async (_t: string, path: string) => {
      if (path.startsWith("/zones/zone_1/settings/ssl")) return strict;
      if (path.includes("/rulesets/")) return { rules: [{ action_parameters: { ssl: "flexible" } }] };
      return zoneOk();
    });
    await expect(
      preflightCloudflareOriginCa({ apiToken: "tok", zoneId: "zone_1", hostname: "site.example.com" }),
    ).rejects.toMatchObject({ code: "TLS_CONFIGURATION_UNRESOLVED" });
  });

  it("a ruleset that does NOT touch SSL is fine (zone default applies)", async () => {
    cf.fetch.mockImplementation(async (_t: string, path: string) => {
      if (path.startsWith("/zones/zone_1/settings/ssl")) return strict;
      if (path.includes("/rulesets/")) return { rules: [{ action_parameters: { rocket_loader: true } }] };
      return zoneOk();
    });
    await expect(
      preflightCloudflareOriginCa({ apiToken: "tok", zoneId: "zone_1", hostname: "site.example.com" }),
    ).resolves.toMatchObject({ zoneName: "example.com" });
  });

  it("no ruleset (404) means the zone default IS the effective mode", async () => {
    // Default beforeEach mock throws providerStatus 404 for rulesets.
    await expect(
      preflightCloudflareOriginCa({ apiToken: "tok", zoneId: "zone_1", hostname: "site.example.com" }),
    ).resolves.toMatchObject({ zoneName: "example.com" });
  });

  it("an unreadable ruleset leaves the effective mode unproven — refused, retryable", async () => {
    cf.fetch.mockImplementation(async (_t: string, path: string) => {
      if (path.startsWith("/zones/zone_1/settings/ssl")) return strict;
      if (path.includes("/rulesets/")) throw new AppError("rulesets read failed", 502, "CLOUDFLARE_API_ERROR");
      return zoneOk();
    });
    await expect(
      preflightCloudflareOriginCa({ apiToken: "tok", zoneId: "zone_1", hostname: "site.example.com" }),
    ).rejects.toMatchObject({ code: "TLS_CONFIGURATION_UNRESOLVED" });
  });
});
