import { describe, expect, it } from "vitest";
import type Dockerode from "dockerode";
import type { DiscoveryCandidateInput } from "@repo/core";
import { discoveryContainerViewFromDockerInspect } from "./docker-container-info";

function inspect(overrides: Record<string, unknown> = {}): Dockerode.ContainerInspectInfo {
  return {
    Id: "abc123",
    Name: "/my-app.1",
    Config: {
      Image: "my-app:v2",
      Env: [
        "OPENSHIP_DISCOVERY=true",
        "OPENSHIP_SERVICE_ID=my-app",
        "OPENSHIP_DOMAIN=app.example.com",
        "OPENSHIP_PORT=3000",
        "DATABASE_URL=postgres://secrets", // must be filtered out
        "PATH=/usr/bin",
      ],
      Labels: {
        "openship.discovery": "true",
        "openship.service.id": "my-app",
        "com.docker.compose.project": "shop",
        "com.docker.compose.service": "web",
        "app.kubernetes.io/managed-by": "helm", // outside the namespaces → dropped
        "user.custom": "keep-out",
      },
    },
    State: { Status: "running", Running: true, StartedAt: "2026-01-01T00:00:00Z" },
    NetworkSettings: {
      Networks: {
        frontend: { NetworkID: "net_fe", IPAddress: "172.20.0.5" },
        backend: { NetworkID: "net_be", IPAddress: "172.21.0.2" },
      },
    },
    ...overrides,
  } as unknown as Dockerode.ContainerInspectInfo;
}

describe("discovery container view", () => {
  it("keeps the per-network map with ids and IPv4 addresses", () => {
    const view = discoveryContainerViewFromDockerInspect(inspect(), "abc123");
    expect(view.networks).toEqual([
      { name: "frontend", id: "net_fe", ipAddress: "172.20.0.5" },
      { name: "backend", id: "net_be", ipAddress: "172.21.0.2" },
    ]);
  });

  it("filters env to OPENSHIP_* and labels to openship/compose namespaces", () => {
    const view = discoveryContainerViewFromDockerInspect(inspect(), "abc123");
    expect(view.env).toEqual([
      "OPENSHIP_DISCOVERY=true",
      "OPENSHIP_SERVICE_ID=my-app",
      "OPENSHIP_DOMAIN=app.example.com",
      "OPENSHIP_PORT=3000",
    ]);
    expect(view.labels).toEqual({
      "openship.discovery": "true",
      "openship.service.id": "my-app",
      "com.docker.compose.project": "shop",
      "com.docker.compose.service": "web",
    });
    expect(JSON.stringify(view)).not.toContain("postgres://");
    expect(JSON.stringify(view)).not.toContain("helm");
  });

  it("reports fresh running state and normalized status", () => {
    const running = discoveryContainerViewFromDockerInspect(inspect(), "abc123");
    expect(running.running).toBe(true);
    expect(running.status).toBe("running");

    const stopped = discoveryContainerViewFromDockerInspect(
      inspect({ State: { Status: "exited", Running: false } }),
      "abc123",
    );
    expect(stopped.running).toBe(false);
    expect(stopped.status).toBe("stopped");

    const restarting = discoveryContainerViewFromDockerInspect(
      inspect({ State: { Status: "restarting", Running: true, Restarting: true } }),
      "abc123",
    );
    expect(restarting.status).toBe("deploying");
  });

  it("strips the leading slash from names and tolerates missing sections", () => {
    const bare = discoveryContainerViewFromDockerInspect(
      inspect({ Name: undefined, Config: undefined, NetworkSettings: undefined, State: undefined }),
      "abc123",
    );
    expect(bare.name).toBeUndefined();
    expect(bare.image).toBeUndefined();
    expect(bare.env).toEqual([]);
    expect(bare.labels).toEqual({});
    expect(bare.networks).toEqual([]);
    expect(bare.running).toBe(false);
  });

  it("feeds the parser: ambiguous without a selector, resolved with one", async () => {
    const { parseDiscoveryDeclaration } = await import("@repo/core");
    const view = discoveryContainerViewFromDockerInspect(inspect(), "abc123");
    // The runtime view feeds the parser directly once drivers are enriched.
    const enriched: DiscoveryCandidateInput = {
      env: view.env,
      labels: view.labels,
      networks: view.networks.map((n) => ({ ...n, driver: "bridge" })),
    };

    // Two usable networks, no OPENSHIP_NETWORK → ambiguous, never guessed.
    const ambiguous = parseDiscoveryDeclaration(enriched);
    expect(ambiguous).toEqual({
      eligible: false,
      rejection: {
        kind: "invalid",
        code: "network-ambiguous",
        serviceKey: "id:my-app", // identity resolves before network checks
        message: expect.stringContaining("OPENSHIP_NETWORK"),
      },
    });

    // With a selector, the declaration carries the SELECTED network's IP source.
    const resolved = parseDiscoveryDeclaration({
      ...enriched,
      env: [...(enriched.env ?? []), "OPENSHIP_NETWORK=frontend"],
    });
    expect(resolved).toEqual({
      eligible: true,
      declaration: {
        serviceKey: "id:my-app",
        serviceId: "my-app",
        composeProject: "shop",
        composeService: "web",
        hostname: "app.example.com",
        port: 3000,
        network: "frontend",
        networkId: "net_fe",
      },
    });
  });
});
