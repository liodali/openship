import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  list: vi.fn(),
  record: vi.fn(),
  execution: vi.fn(),
  probe: vi.fn(),
}));
vi.mock("@repo/db", () => ({
  repos: {
    actions: {
      listServerRunnerDestinations: mock.list,
      recordRunnerProbe: mock.record,
    },
  },
}));
vi.mock("@repo/adapters", () => ({
  probeActionCapabilities: mock.probe,
  ensureDockerEmulation: vi.fn(),
}));
vi.mock("../../lib/server-execution", () => ({ withServerExecution: mock.execution }));
vi.mock("../jobs/job-access", () => ({ assertJobServersWritable: async () => {} }));
vi.mock("./access", () => ({ authorizeActionRunners: async () => {} }));

import { probeActionRunnerSweep } from "./runner.service";

const capabilities = {
  os: "linux",
  architecture: "x64",
  docker: true,
  git: true,
  node: true,
  distribution: "ubuntu",
  version: "22.04",
} as const;

describe("runner heartbeat sweep", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mock.record.mockResolvedValue({});
  });

  it("refreshes checkedAt for every enabled server runner", async () => {
    mock.list.mockResolvedValue([
      { id: "r1", organizationId: "org", serverId: "s1", name: "One" },
      { id: "r2", organizationId: "org", serverId: "s2", name: "Two" },
    ]);
    mock.execution.mockResolvedValue(capabilities);

    const result = await probeActionRunnerSweep();

    expect(result).toEqual({ probed: 2, failed: 0 });
    expect(mock.execution).toHaveBeenCalledTimes(2);
    for (const id of ["r1", "r2"]) {
      const call = mock.record.mock.calls.find(([, runnerId]) => runnerId === id)!;
      expect(call[0]).toBe("org");
      expect(call[2].capabilities).toEqual(capabilities);
      expect(call[2].error).toBeNull();
      expect(call[2].checkedAt).toBeInstanceOf(Date);
    }
  });

  it("records the failure on the runner row and keeps sweeping", async () => {
    mock.list.mockResolvedValue([
      { id: "r1", organizationId: "org", serverId: "s1", name: "One" },
      { id: "r2", organizationId: "org", serverId: "s2", name: "Two" },
    ]);
    mock.execution.mockRejectedValueOnce(new Error("SSH unreachable")).mockResolvedValue(capabilities);

    const result = await probeActionRunnerSweep();

    expect(result).toEqual({ probed: 2, failed: 1 });
    const failed = mock.record.mock.calls.find(([, id]) => id === "r1")![2];
    expect(failed.error).toContain("SSH unreachable");
    expect(failed.capabilities).toBeNull();
    expect(mock.record).toHaveBeenCalledTimes(2);
  });
});
