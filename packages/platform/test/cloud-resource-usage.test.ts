import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ server: vi.fn(), connection: vi.fn(), stream: vi.fn() }));
vi.mock("@repo/db", () => ({ repos: { server: { getInOrganization: h.server } } }));
vi.mock("../src/engine/lib/cloud-workspace-host", () => ({
  readCloudWorkspaceConnection: h.connection,
}));
import {
  normalizeResourceUsage,
  streamCloudResourceUsage,
} from "../src/engine/lib/cloud-resource-usage";

beforeEach(() => {
  vi.resetAllMocks();
  h.server.mockResolvedValue({ workspaceId: "space-owned" });
  h.connection.mockResolvedValue({
    binding: { workspaceId: "vm-owned" },
    provider: { workspace: { status: "running" } },
    client: { streamWorkspaceMetrics: h.stream },
  });
  h.stream.mockImplementation(async function* () {
    yield { cpuUsage: 25 };
  });
});
it("converts guest bytes, uses quota-relative CPU, and strips provider-only fields", () => {
  const sample = normalizeResourceUsage({
    cpuUsage: 12.5,
    guestMemoryUsed: 1048576,
    guestMemoryTotal: 8388608,
    memoryUsedMB: 99,
    memoryTotalMB: 100,
    guestDiskUsed: 2097152,
    guestDiskTotal: 16777216,
    token: "private",
    apiCalls: 42,
  });
  expect(sample).toMatchObject({
    cpuPercent: 12.5,
    memoryUsedMb: 1,
    memoryAvailableMb: 7,
    diskUsedMb: 2,
    diskTotalMb: 16,
    diskAvailableMb: 14,
  });
  expect(JSON.stringify(sample)).not.toMatch(/private|apiCalls|token/);
  expect(
    normalizeResourceUsage({ cpuUsage: 0, memoryUsedMB: 16, memoryTotalMB: 128 }),
  ).toMatchObject({ cpuPercent: 0, memoryUsedMb: 16, memoryAvailableMb: 112, diskUsedMb: null });
});
it("preserves missing data as unknown and rejects wholly unreadable metrics", () => {
  expect(
    normalizeResourceUsage({ cpuUsage: 8, guestDiskUsed: -1, guestMemoryUsed: Infinity }),
  ).toMatchObject({ cpuPercent: 8, memoryUsedMb: null, diskUsedMb: null });
  expect(normalizeResourceUsage({ guestMemoryUsed: 1048576, memoryTotalMB: 8 })).toMatchObject({
    memoryUsedMb: 1,
    memoryAvailableMb: null,
  });
  for (const raw of [null, [], {}, { cpuUsage: "25", memoryUsedMB: NaN }])
    expect(() => normalizeResourceUsage(raw)).toThrow();
});
it("streams the owned binding using the scoped client and propagates cancellation", async () => {
  const abort = new AbortController();
  const source = streamCloudResourceUsage("org-a", "server-a", abort.signal);
  const event = (await source.next()).value!;
  expect(event.event).toBe("usage");
  expect(JSON.parse(event.data)).toMatchObject({ cpuPercent: 25, diskUsedMb: null });
  expect(h.server).toHaveBeenCalledWith("server-a", "org-a");
  expect(h.connection).toHaveBeenCalledWith("org-a", "space-owned");
  expect(h.stream).toHaveBeenCalledWith("vm-owned", abort.signal);
  abort.abort();
  await source.return();
});
it("never opens a stream for a missing server, failed ownership check, or stopped space", async () => {
  h.server.mockResolvedValueOnce(null);
  await expect(streamCloudResourceUsage("org-a", "foreign").next()).rejects.toThrow();
  expect(h.connection).not.toHaveBeenCalled();
  h.connection.mockRejectedValueOnce(new Error("Ownership changed"));
  await expect(streamCloudResourceUsage("org-a", "server-a").next()).rejects.toThrow(
    "Ownership changed",
  );
  h.connection.mockResolvedValueOnce({
    provider: { workspace: { status: "active", info: { is_running: false } } },
  });
  await expect(streamCloudResourceUsage("org-a", "server-a").next()).rejects.toMatchObject({
    code: "CLOUD_WORKSPACE_NOT_RUNNING",
  });
  expect(h.stream).not.toHaveBeenCalled();
});
