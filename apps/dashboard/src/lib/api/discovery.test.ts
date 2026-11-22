import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * URL construction for the discovery API. Service keys are stable discovery
 * identities (`id:my-app`, `compose:proj/serv`) that travel in the URL path —
 * the slash inside a Compose identity MUST be percent-encoded or the router
 * matches it as a path separator and the request 404s. Hono decodes the
 * segment server-side (`c.req.param` applies decodeURIComponent).
 */
const { api } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

// Keep the real module's ApiError/getApiErrorMessage: the checked-response
// guard throws ApiError(502) for malformed bodies.
vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, api };
});

import { discoveryApi } from "./discovery";

describe("discoveryApi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads status from the server-scoped discovery resource", () => {
    discoveryApi.status("srv_1");
    expect(api.get).toHaveBeenCalledWith("discovery/servers/srv_1/discovery", undefined);
  });

  it("reads ONE service by its key, encoding both separators in the path", () => {
    discoveryApi.service("srv_1", "compose:proj/serv");
    expect(api.get).toHaveBeenCalledWith(
      "discovery/servers/srv_1/discovery/services/compose%3Aproj%2Fserv",
      undefined,
    );
    discoveryApi.service("srv_1", "id:my-app", { signal: expect.any(AbortSignal) });
    expect(api.get).toHaveBeenCalledWith("discovery/servers/srv_1/discovery/services/id%3Amy-app", {
      signal: expect.any(AbortSignal),
    });
  });

  it("TLS configuration APIs ride the same URL rules", () => {
    discoveryApi.tlsSettings("srv_1");
    expect(api.get).toHaveBeenCalledWith("discovery/servers/srv_1/discovery/tls", undefined);
    discoveryApi.configureTlsSettings("srv_1", { defaultProvider: "cloudflare-origin-ca" });
    expect(api.put).toHaveBeenCalledWith("discovery/servers/srv_1/discovery/tls", {
      defaultProvider: "cloudflare-origin-ca",
    });
    discoveryApi.serviceTls("srv_1", "id:my-app");
    expect(api.get).toHaveBeenCalledWith(
      "discovery/servers/srv_1/discovery/services/id%3Amy-app/tls",
      undefined,
    );
    discoveryApi.configureServiceTls("srv_1", "compose:proj/serv", {
      provider: "cloudflare-origin-ca",
      cloudflare: { credentialId: "cred_1", zoneId: "zone_1" },
    });
    expect(api.put).toHaveBeenCalledWith(
      "discovery/servers/srv_1/discovery/services/compose%3Aproj%2Fserv/tls",
      {
        provider: "cloudflare-origin-ca",
        cloudflare: { credentialId: "cred_1", zoneId: "zone_1" },
      },
      { timeout: 30_000, dedupe: false },
    );
    // The ensure action rides the same single-segment rule: a Compose key's
    // slash MUST stay percent-encoded or the router matches it as a separator.
    discoveryApi.ensureTls("srv_1", "compose:proj/serv");
    expect(api.post).toHaveBeenCalledWith(
      "discovery/servers/srv_1/discovery/services/compose%3Aproj%2Fserv/tls/ensure",
      {},
      { timeout: 30_000, dedupe: false },
    );
    discoveryApi.ensureTls("srv_1", "id:my-app");
    expect(api.post).toHaveBeenCalledWith(
      "discovery/servers/srv_1/discovery/services/id%3Amy-app/tls/ensure",
      {},
      { timeout: 30_000, dedupe: false },
    );
  });

  it("encodes BOTH separators of a Compose service key in the path", () => {
    discoveryApi.suppress("srv_1", "compose:proj/serv");
    expect(api.post).toHaveBeenCalledWith(
      "discovery/servers/srv_1/discovery/services/compose%3Aproj%2Fserv/suppress",
    );
    discoveryApi.unsuppress("srv_1", "compose:proj/serv");
    expect(api.post).toHaveBeenCalledWith(
      "discovery/servers/srv_1/discovery/services/compose%3Aproj%2Fserv/unsuppress",
    );
    discoveryApi.forget("srv_1", "compose:proj/serv");
    expect(api.delete).toHaveBeenCalledWith(
      "discovery/servers/srv_1/discovery/services/compose%3Aproj%2Fserv",
    );
  });

  it("keeps a plain id: key intact while still encoding it defensively", () => {
    discoveryApi.suppress("srv_1", "id:my-app");
    expect(api.post).toHaveBeenCalledWith(
      "discovery/servers/srv_1/discovery/services/id%3Amy-app/suppress",
    );
  });

  it("lets rescan run far longer than the default timeout and never dedupes", async () => {
    api.post.mockResolvedValue({
      serverId: "srv_1",
      failed: [],
      scan: { scanned: 0, ok: true },
      reconcile: null,
      repair: null,
    });
    await discoveryApi.rescan("srv_1");
    expect(api.post).toHaveBeenCalledWith("discovery/servers/srv_1/discovery/rescan", undefined, {
      timeout: 180_000,
      dedupe: false,
    });
  });

  it("rejects an HTTP 200 rescan body that is not the documented summary", async () => {
    // `{}` carries no sweep truth at all — returning it would let the card
    // report "Rescan complete" for an UNKNOWN sweep. It must throw instead.
    api.post.mockResolvedValue({});
    await expect(discoveryApi.rescan("srv_1")).rejects.toMatchObject({ status: 502 });

    api.post.mockResolvedValue({ serverId: "srv_1", failed: "nope" });
    await expect(discoveryApi.rescan("srv_1")).rejects.toMatchObject({ status: 502 });
  });

  it("sends the enable/disable toggle as the JSON body of the PUT", () => {
    discoveryApi.configure("srv_1", { enabled: false });
    expect(api.put).toHaveBeenCalledWith("discovery/servers/srv_1/discovery", { enabled: false });
  });
});
