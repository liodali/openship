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
