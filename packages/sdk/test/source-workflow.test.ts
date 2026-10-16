import { describe, expect, it, vi } from "vitest";
import type {
  ProjectOperations,
  SourceOperations,
  DeploymentOperations,
  StagedSource,
  SourceScan,
} from "@repo/contracts";
import { deploySourceWorkflow } from "../src/source-workflow";
import type { DeploySourceInput } from "../src/source-input";

/**
 * The folder-deploy pipeline: stage → scan → projects/ensure →
 * deployments/build/access. These pin the fork's fix — declared domains
 * (openship.json `domains[]`) must reach BOTH ensure and build/access, or a
 * self-hosted server deploy 403s at the Cloud preflight
 * (hasManagedProjectDomain) with "Connect Openship Cloud to use a free
 * subdomain".
 */

const baseScan: SourceScan = {
  serverId: "server-1",
  name: "bt",
  stack: "docker",
  projectType: "docker",
  packageManager: "npm",
  installCommand: "",
  buildCommand: "",
  startCommand: "sh -c 'sleep 3600'",
  buildImage: "",
  outputDirectory: "",
  rootDirectory: "",
  port: 8080,
  workloadType: "web",
} as unknown as SourceScan;

const scanWithEndpoints: SourceScan = {
  ...baseScan,
  publicEndpoints: [
    // Scan shape: EnsureProjectBody endpoints — NUMERIC port.
    { customDomain: "bt.example.com", domainType: "custom", port: 8080 },
  ],
} as unknown as SourceScan;

function setup(scan: SourceScan) {
  const ensure = vi.fn(async () => ({ project_id: "project-1" }));
  const buildAccess = vi.fn(async () => ({ deployment_id: "dep-1", project_id: "project-1" }));
  const ship = {
    projects: { ensure } as unknown as ProjectOperations,
    sources: {
      stage: vi.fn(
        async (): Promise<StagedSource> => ({
          sessionId: "session-1",
          serverId: "server-1",
          expiresAt: Date.now() + 60_000,
        }),
      ),
      scan: vi.fn(async () => scan),
    } as unknown as SourceOperations,
    deployments: { buildAccess } as unknown as DeploymentOperations,
  };
  const input: DeploySourceInput = {
    source: { type: "directory", path: "/tmp/app" },
    environment: "production",
  };
  return { ship, ensure, buildAccess, input };
}

describe("deploySourceWorkflow publicEndpoints passthrough", () => {
  it("sends declared scan endpoints to projects/ensure (numeric port) and build/access (string port)", async () => {
    const { ship, ensure, buildAccess, input } = setup(scanWithEndpoints);

    await deploySourceWorkflow(ship, input);

    expect(ensure).toHaveBeenCalledTimes(1);
    const ensured = ensure.mock.calls[0][0] as { publicEndpoints?: Array<Record<string, unknown>> };
    expect(ensured.publicEndpoints).toEqual([
      { customDomain: "bt.example.com", domainType: "custom", port: 8080 },
    ]);

    expect(buildAccess).toHaveBeenCalledTimes(1);
    const deployed = buildAccess.mock.calls[0][0] as {
      publicEndpoints?: Array<Record<string, unknown>>;
    };
    // BuildAccessBody's PublicEndpointInput takes the port as a STRING —
    // strict Value.Check rejects the numeric scan shape, so the workflow must
    // convert (the deploy wizard stringifies the same way).
    expect(deployed.publicEndpoints).toEqual([
      { customDomain: "bt.example.com", domainType: "custom", port: "8080" },
    ]);
  });

  it("omits publicEndpoints everywhere when the scan declared no domains", async () => {
    const { ship, ensure, buildAccess, input } = setup(baseScan);

    await deploySourceWorkflow(ship, input);

    expect((ensure.mock.calls[0][0] as Record<string, unknown>).publicEndpoints).toBeUndefined();
    expect(
      (buildAccess.mock.calls[0][0] as Record<string, unknown>).publicEndpoints,
    ).toBeUndefined();
  });

  it("keeps redirect fields through the conversion", async () => {
    const scan = {
      ...baseScan,
      publicEndpoints: [
        {
          customDomain: "www.example.com",
          domainType: "custom",
          port: 8080,
          redirectTo: "example.com",
          redirectStatus: 308,
        },
      ],
    } as unknown as SourceScan;
    const { ship, buildAccess, input } = setup(scan);

    await deploySourceWorkflow(ship, input);

    const deployed = buildAccess.mock.calls[0][0] as {
      publicEndpoints?: Array<Record<string, unknown>>;
    };
    expect(deployed.publicEndpoints).toEqual([
      {
        customDomain: "www.example.com",
        domainType: "custom",
        port: "8080",
        redirectTo: "example.com",
        redirectStatus: 308,
      },
    ]);
  });
});

// §10 of the podman build brief: a single-app Dockerfile deploy whose scan
// reports a container port must ensure a WEB workload. The scan's
// startCommand/buildCommand are empty (the repository Dockerfile owns the
// process), which used to derive hasServer=false → workloadType=static →
// productionMode=static, and the deploy preflight rejected the port-targeted
// route ("Static deployments cannot expose port-targeted routes").
describe("deploySourceWorkflow single-app web derivation", () => {
  // The §10 repro scan: docker project, port detected, no commands.
  const dockerScan: SourceScan = {
    ...baseScan,
    startCommand: "",
  } as unknown as SourceScan;

  it("derives workloadType=web, hasServer=true, hasBuild=true, productionMode=host for a port-served Dockerfile app", async () => {
    const { ship, ensure, input } = setup(dockerScan);

    await deploySourceWorkflow(ship, input);

    const body = ensure.mock.calls[0][0] as Record<string, unknown>;
    expect(body.workloadType).toBe("web");
    expect(body.hasServer).toBe(true);
    expect(body.hasBuild).toBe(true);
    expect(body.productionMode).toBe("host");
    expect(body.port).toBe(8080);
  });

  it("respects an explicitly declared static workload over the derivation", async () => {
    const { ship, ensure, input } = setup({
      ...dockerScan,
      workloadType: "static",
    } as unknown as SourceScan);

    await deploySourceWorkflow(ship, input);

    const body = ensure.mock.calls[0][0] as Record<string, unknown>;
    expect(body.workloadType).toBe("static");
    expect(body.hasServer).toBe(false);
    expect(body.productionMode).toBe("static");
  });

  it("respects an explicitly declared worker workload over the derivation", async () => {
    const { ship, ensure, input } = setup({
      ...dockerScan,
      workloadType: "worker",
    } as unknown as SourceScan);

    await deploySourceWorkflow(ship, input);

    const body = ensure.mock.calls[0][0] as Record<string, unknown>;
    expect(body.workloadType).toBe("worker");
    expect(body.hasServer).toBe(false);
  });

  it("leaves multi-service (compose) deploys untouched", async () => {
    const scan = {
      ...dockerScan,
      workloadType: "static",
      services: [
        {
          name: "web",
          image: "nginx:alpine",
          ports: [],
          dependsOn: [],
          environment: {},
          volumes: [],
          publicEndpoints: [{ port: "8080", domainType: "custom", customDomain: "a.example.com" }],
        },
      ],
    } as unknown as SourceScan;
    const { ship, ensure, input } = setup(scan);

    await deploySourceWorkflow(ship, input);

    const body = ensure.mock.calls[0][0] as Record<string, unknown>;
    expect(body.workloadType).toBe("static");
    expect(body.hasServer).toBe(false);
    expect(body.productionMode).toBe("static");
  });

  it("leaves a portless single-app upload on the static derivation", async () => {
    const { port: _port, workloadType: _wt, ...portless } = dockerScan;
    const { ship, ensure, input } = setup(portless as unknown as SourceScan);

    await deploySourceWorkflow(ship, input);

    const body = ensure.mock.calls[0][0] as Record<string, unknown>;
    expect(body.workloadType).toBeUndefined();
    expect(body.hasServer).toBe(false);
    expect(body.productionMode).toBe("static");
  });

  it("keeps a declared productionMode authoritative for the web derivation", async () => {
    const { ship, ensure, input } = setup({
      ...dockerScan,
      productionMode: "standalone",
    } as unknown as SourceScan);

    await deploySourceWorkflow(ship, input);

    const body = ensure.mock.calls[0][0] as Record<string, unknown>;
    expect(body.workloadType).toBe("web");
    expect(body.productionMode).toBe("standalone");
  });

  it("does not force hasBuild for a port-served non-docker framework", async () => {
    // e.g. a runtime app with no install/build steps and a plain start command.
    const scan = {
      ...dockerScan,
      projectType: "app",
      stack: "node",
      startCommand: "node server.js",
    } as unknown as SourceScan;
    const { ship, ensure, input } = setup(scan);

    await deploySourceWorkflow(ship, input);

    const body = ensure.mock.calls[0][0] as Record<string, unknown>;
    expect(body.workloadType).toBe("web");
    expect(body.hasBuild).toBe(false);
  });
});
