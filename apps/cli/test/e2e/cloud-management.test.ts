import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudWorkspaceSummary } from "@repo/contracts";

vi.mock("../../src/lib/config", () => ({
  getApiUrl: () => "https://cloud.example.test",
  getToken: () => "opsh_pat_fixture",
}));
vi.mock("../../src/lib/caps", () => ({
  fetchCaps: async () => ({ selfHosted: false }),
  requireSelfHost: () => {
    throw new Error("Self-hosted only");
  },
}));

import { billingCommand } from "../../src/commands/billing";
import { serverCommand } from "../../src/commands/server";
import { serverFixture } from "../../../../packages/contracts/test/fixtures";
import { setJsonMode } from "../../src/lib/output";
import { runCommand, stubFetch, type FetchStub } from "../helpers/harness";

const workspace: CloudWorkspaceSummary = {
  id: "workspace-cloud",
  serverId: "server-cloud",
  name: "Production",
  planTierId: "pro",
  subscriptionStatus: "active",
  projectCount: 2,
  state: "running",
  resources: { cpuCores: 4, memoryMb: 16384, diskMb: 131072 },
  operation: null,
  createdAt: "2026-10-07T00:00:00.000Z",
};
const server = {
  ...serverFixture(workspace.serverId),
  managed: workspace,
  connection: "cloud",
  source: "cloud",
  sshHost: null,
};
let fetchStub: FetchStub;
beforeEach(() => setJsonMode(true));
afterEach(() => {
  fetchStub?.restore();
  setJsonMode(false);
});

describe("Cloud server and billing commands", () => {
  it("lists Cloud servers through the shared SDK without the self-host-only gate", async () => {
    fetchStub = stubFetch(() => ({ json: [server] }));
    const result = await runCommand(serverCommand, ["list"]);
    expect(result.code, result.err).toBe(0);
    expect(JSON.parse(result.out)).toEqual([server]);
    expect(fetchStub.calls[0]).toMatchObject({
      url: "https://cloud.example.test/api/system/servers",
      method: "GET",
    });
  });

  it("continues to reject SSH-server registration on a Cloud control plane", async () => {
    fetchStub = stubFetch(() => {
      throw new Error("Must not register an SSH host on Cloud");
    });
    const result = await runCommand(serverCommand, ["add", "--host", "example.test"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("Self-hosted only");
    expect(fetchStub.calls).toEqual([]);
  });

  it("keeps Cloud management inside the selected Openship API and its SDK", async () => {
    fetchStub = stubFetch(() => ({
      json: { ...workspace, state: "pending", subscriptionStatus: "unpaid" },
    }));
    const result = await runCommand(serverCommand, ["managed", "create", "Demo"]);
    expect(result.code, result.err).toBe(0);
    expect(JSON.parse(result.out).state).toBe("pending");
    expect(fetchStub.calls).toHaveLength(1);
    expect(fetchStub.calls[0]).toMatchObject({
      url: "https://cloud.example.test/api/system/servers/managed",
      method: "POST",
      body: { name: "Demo" },
      headers: { authorization: "Bearer opsh_pat_fixture" },
    });
  });

  it("resolves a selected server to its exact billing workspace before creating a checkout", async () => {
    fetchStub = stubFetch((req) =>
      req.url.endsWith("/system/servers/server-cloud")
        ? { json: server }
        : { json: { data: { checkoutUrl: "https://payments.example.test/checkout" } } },
    );
    const result = await runCommand(billingCommand, [
      "subscription",
      "create",
      "pro",
      "--server",
      "server-cloud",
      "--idempotency-key",
      "checkout-fixture-0001",
    ]);
    expect(result.code, result.err).toBe(0);
    expect(JSON.parse(result.out)).toEqual({
      checkoutUrl: "https://payments.example.test/checkout",
    });
    expect(fetchStub.calls).toHaveLength(2);
    expect(fetchStub.calls[1]).toMatchObject({
      url: "https://cloud.example.test/api/billing/subscription",
      method: "POST",
      body: {
        planTierId: "pro",
        interval: "monthly",
        workspaceId: "workspace-cloud",
        idempotencyKey: "checkout-fixture-0001",
      },
    });
  });

  it("passes a stable server creation key through the public SDK and rejects malformed keys before HTTP", async () => {
    fetchStub = stubFetch(() => ({ json: { ...workspace, state: "needs_plan", planTierId: "free" } }));
    const result = await runCommand(serverCommand, ["managed", "create", "Demo", "--idempotency-key", "purchase-fixture-0001"]);
    expect(result.code, result.err).toBe(0);
    expect(fetchStub.calls[0]).toMatchObject({ method: "POST", body: { name: "Demo", idempotencyKey: "purchase-fixture-0001" } });
    const invalid = await runCommand(serverCommand, ["managed", "create", "Demo", "--idempotency-key", "short"]);
    expect(invalid.code).toBe(1);
    expect(fetchStub.calls).toHaveLength(1);
  });

  it("rejects an invalid plan before resolving a server or creating a payment", async () => {
    fetchStub = stubFetch(() => {
      throw new Error("Must validate before network access");
    });
    const result = await runCommand(billingCommand, [
      "subscription",
      "create",
      "invented",
      "--server",
      "server-cloud",
    ]);
    expect(result.code).toBe(1);
    expect(fetchStub.calls).toEqual([]);
  });

  it("refuses to associate an unmanaged server with another subscription", async () => {
    fetchStub = stubFetch(() => ({ json: serverFixture("server-owned") }));
    const result = await runCommand(billingCommand, [
      "subscription",
      "get",
      "--server",
      "server-owned",
    ]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("no managed subscription");
    expect(fetchStub.calls).toHaveLength(1);
  });

  it("recovers the existing checkout using its opaque action ID and workspace", async () => {
    fetchStub = stubFetch(() => ({
      json: {
        data: {
          status: "ready",
          checkoutId: "cs_fixture",
          checkoutUrl: "https://payments.example.test/recovered",
        },
      },
    }));
    const id = "a".repeat(64);
    const result = await runCommand(billingCommand, [
      "checkout",
      "resume",
      id,
      "--workspace",
      workspace.id,
    ]);
    expect(result.code, result.err).toBe(0);
    expect(fetchStub.calls).toHaveLength(1);
    expect(fetchStub.calls[0]).toMatchObject({
      url: "https://cloud.example.test/api/billing/checkout/resume",
      method: "POST",
      body: { workspaceId: workspace.id, id },
    });
  });

  it("does not cancel renewal without confirmation or retry a denied cancellation", async () => {
    fetchStub = stubFetch(() => ({
      status: 403,
      json: { code: "FORBIDDEN", error: "Billing administration required" },
    }));
    expect(
      (await runCommand(billingCommand, ["subscription", "cancel", "--workspace", workspace.id]))
        .code,
    ).toBe(1);
    expect(fetchStub.calls).toEqual([]);
    const result = await runCommand(billingCommand, [
      "subscription",
      "cancel",
      "--workspace",
      workspace.id,
      "--yes",
    ]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("Billing administration required");
    expect(fetchStub.calls).toHaveLength(1);
    expect(fetchStub.calls[0].body).toEqual({ workspaceId: workspace.id });
  });

  it("passes the exact approved resize revision and preserves conflict failures", async () => {
    fetchStub = stubFetch(() => ({
      status: 409,
      json: { code: "REVISION_CONFLICT", error: "Capacity changed; review a new preview" },
    }));
    const revision = "b".repeat(64);
    const args = [
      "managed",
      "resize",
      workspace.serverId,
      "--revision",
      revision,
      "--idempotency-key",
      "resize-fixture-0001",
      "--confirm-restart",
    ];
    expect((await runCommand(serverCommand, args)).code).toBe(1);
    expect(fetchStub.calls).toEqual([]);
    const result = await runCommand(serverCommand, [...args, "--yes"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("Capacity changed");
    expect(fetchStub.calls).toHaveLength(1);
    expect(fetchStub.calls[0].body).toEqual({
      revision,
      idempotencyKey: "resize-fixture-0001",
      confirmRestart: true,
    });
  });

  it("propagates a server command's failure instead of reporting successful execution", async () => {
    const outcome = {
      exitCode: 7,
      output: "command failed\n",
      truncated: false,
      timedOut: false,
      durationMs: 10,
    };
    fetchStub = stubFetch(() => ({ json: { data: outcome } }));
    const result = await runCommand(serverCommand, ["exec", workspace.serverId, "exit 7"]);
    expect(result.code).toBe(7);
    expect(JSON.parse(result.out)).toEqual(outcome);
    expect(fetchStub.calls[0]).toMatchObject({ method: "POST", body: { command: "exit 7" } });
  });
});
