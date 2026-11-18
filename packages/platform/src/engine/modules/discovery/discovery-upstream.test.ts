import { describe, expect, it, vi } from "vitest";
import { discoveryConfigHash, type DiscoveryContainerView } from "@repo/core";
import type { DiscoveryBinding } from "@repo/db";
import type { TcpProbeResult } from "@repo/adapters";
import { resolveReachableDiscoveryUpstream, assertDiscoveryUpstreamCurrent } from "./discovery-upstream";

function fixture(rootless = false) {
  const view: DiscoveryContainerView = {
    containerId: "ctr_1", status: "running", running: true, labels: {},
    env: ["OPENSHIP_DISCOVERY=true", "OPENSHIP_SERVICE_ID=app", "OPENSHIP_DOMAIN=app.example.com", "OPENSHIP_PORT=3000"],
    networks: rootless ? [] : [{ id: "net_1", name: "frontend", ipAddress: "172.20.0.5" }],
    publishedPorts: [{ containerPort: 3000, hostPort: 18080, hostIp: "0.0.0.0" }],
  };
  const binding = {
    serviceKey: "id:app", containerId: "ctr_1", hostname: "app.example.com", port: 3000,
    configHash: discoveryConfigHash({ hostname: "app.example.com", port: 3000, network: rootless ? undefined : "frontend" }),
    upstreamStrategy: "network-ip", ipAddress: "172.20.0.5", hostPort: null, hostIp: null,
  } as DiscoveryBinding;
  const runtime = {
    getDiscoveryContainerView: vi.fn(async () => view),
    listAllNetworks: vi.fn(async () => [{ id: "net_1", name: "frontend", driver: "bridge", labels: {} }]),
  };
  const probe = vi.fn(async (_host: string, _port: number): Promise<TcpProbeResult> => ({ ok: true }));
  return { view, binding, runtime, probe };
}

describe("discovery upstream reachability", () => {
  it("tries a bridge then the exact live published binding when Edge has no route to the bridge", async () => {
    const { binding, runtime, probe } = fixture();
    probe.mockResolvedValueOnce({ ok: false, reason: "no_route" });
    const result = await resolveReachableDiscoveryUpstream(binding, runtime, probe);
    expect(result.targetUrl).toBe("http://127.0.0.1:18080");
    expect(probe.mock.calls).toEqual([["172.20.0.5", 3000], ["127.0.0.1", 18080]]);
  });

  it("supports a rootless Podman published-only view without requiring a bridge", async () => {
    const { binding, runtime, probe } = fixture(true);
    const result = await resolveReachableDiscoveryUpstream(binding, runtime, probe);
    expect(result.target.upstreamStrategy).toBe("published-port");
    expect(result.targetUrl).toBe("http://127.0.0.1:18080");
    expect(runtime.listAllNetworks).not.toHaveBeenCalled();
  });

  it("keeps a reachable resolved fallback ahead of an unusable bridge", async () => {
    const { binding, runtime, probe } = fixture();
    Object.assign(binding, { upstreamStrategy: "published-port", ipAddress: null, hostPort: 18080, hostIp: "0.0.0.0" });
    await resolveReachableDiscoveryUpstream(binding, runtime, probe);
    expect(probe.mock.calls).toEqual([["127.0.0.1", 18080]]);
  });

  it("uses the actual bind address, including IPv6 loopback, instead of guessing IPv4 loopback", async () => {
    const { binding, runtime, probe, view } = fixture(true);
    view.publishedPorts[0].hostIp = "10.0.0.5";
    expect((await resolveReachableDiscoveryUpstream(binding, runtime, probe)).targetUrl).toBe("http://10.0.0.5:18080");
    view.publishedPorts[0].hostIp = "::";
    expect((await resolveReachableDiscoveryUpstream(binding, runtime, probe)).targetUrl).toBe("http://[::1]:18080");
  });

  it("cannot borrow another container port's binding", async () => {
    const { binding, runtime, probe, view } = fixture(true);
    view.publishedPorts[0].containerPort = 4000;
    await expect(resolveReachableDiscoveryUpstream(binding, runtime, probe)).rejects.toThrow("no longer valid");
    expect(probe).not.toHaveBeenCalled();
  });

  it("refuses cached targets when fresh identity or configuration differs", async () => {
    const { binding, runtime, probe, view } = fixture();
    view.env.push("OPENSHIP_SERVICE_ID=other-service");
    await expect(resolveReachableDiscoveryUpstream(binding, runtime, probe)).rejects.toThrow("configuration changed");
    expect(probe).not.toHaveBeenCalled();
  });

  it("refuses a live TLS declaration that differs from the persisted binding", async () => {
    // Same routing config (hash matches), but the container was recreated with
    // a Cloudflare label the binding has never observed: applying or scheduling
    // certificate work against the stale letsencrypt intent is forbidden.
    const { binding, runtime, probe, view } = fixture();
    view.env.push("OPENSHIP_TLS_PROVIDER=cloudflare-origin-ca");
    await expect(resolveReachableDiscoveryUpstream(binding, runtime, probe)).rejects.toThrow("TLS declaration changed");
    expect(probe).not.toHaveBeenCalled();
  });

  it("refuses a live wildcard source the binding has never observed", async () => {
    const { binding, runtime, probe, view } = fixture();
    view.env.push("OPENSHIP_TLS_WILDCARD=*.example.com");
    await expect(resolveReachableDiscoveryUpstream(binding, runtime, probe)).rejects.toThrow("TLS declaration changed");
    expect(probe).not.toHaveBeenCalled();
  });

  it("accepts a live TLS declaration that matches the persisted binding", async () => {
    const { binding, runtime, probe, view } = fixture();
    view.env.push("OPENSHIP_TLS_PROVIDER=cloudflare-origin-ca");
    Object.assign(binding, { tlsDeclaredProvider: "cloudflare-origin-ca", tlsDeclaredWildcard: null });
    const result = await resolveReachableDiscoveryUpstream(binding, runtime, probe);
    expect(result.targetUrl).toBe("http://172.20.0.5:3000");
  });

  it("re-checks TLS intent after the probe as well", async () => {
    const { binding, runtime, probe, view } = fixture();
    Object.assign(binding, { tlsDeclaredProvider: "letsencrypt", tlsDeclaredWildcard: null });
    view.env.push("OPENSHIP_TLS_PROVIDER=letsencrypt");
    const selected = await resolveReachableDiscoveryUpstream(binding, runtime, probe);
    // The container is recreated mid-probe with a different provider.
    view.env = view.env.map((e) => e === "OPENSHIP_TLS_PROVIDER=letsencrypt" ? "OPENSHIP_TLS_PROVIDER=cloudflare-origin-ca" : e);
    await expect(assertDiscoveryUpstreamCurrent(binding, selected, runtime)).rejects.toThrow("TLS declaration changed");
  });

  it("checks port ownership again after a successful probe", async () => {
    const { binding, runtime, probe, view } = fixture(true);
    const selected = await resolveReachableDiscoveryUpstream(binding, runtime, probe);
    view.publishedPorts[0].hostPort = 18081;
    await expect(assertDiscoveryUpstreamCurrent(binding, selected, runtime)).rejects.toThrow("changed after its probe");
  });

  it("requires a freshly running container", async () => {
    const { binding, runtime, probe, view } = fixture();
    view.running = false;
    await expect(resolveReachableDiscoveryUpstream(binding, runtime, probe)).rejects.toThrow("no longer running");
    expect(probe).not.toHaveBeenCalled();
  });
});
