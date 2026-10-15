import type { ResourceUsageSample } from "@repo/contracts";
import { AppError, NotFoundError } from "@repo/core";
import { repos } from "@repo/db";
import { readCloudWorkspaceConnection } from "./cloud-workspace-host";
import { cloudWorkspaceStatus } from "@repo/adapters";

const nonnegative = (value: unknown): number | null =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= Number.MAX_SAFE_INTEGER
    ? value
    : null;
const mb = (value: unknown) => {
  const bytes = nonnegative(value);
  return bytes === null ? null : bytes / 1048576;
};
const free = (used: number | null, total: number | null) =>
  used === null || total === null ? null : Math.max(0, total - used);

/** Provider metrics are actual quota-relative CPU and guest bytes, not credits,
 * allocation, Docker inventory, or an empty project's consumption. */
export function normalizeResourceUsage(raw: unknown): ResourceUsageSample {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Invalid live resource usage sample");
  const value = raw as Record<string, unknown>;
  const guestMemory = mb(value.guestMemoryUsed);
  const guestTotal = mb(value.guestMemoryTotal);
  const memoryUsedMb = guestMemory ?? nonnegative(value.memoryUsedMB);
  const memoryTotalMb = guestMemory !== null ? guestTotal : nonnegative(value.memoryTotalMB);
  const diskUsedMb = mb(value.guestDiskUsed);
  const diskTotalMb = mb(value.guestDiskTotal);
  const cpuPercent = nonnegative(value.cpuUsage);
  if (cpuPercent === null && memoryUsedMb === null && diskUsedMb === null)
    throw new Error("Live resource usage is unavailable. Retry to reconnect.");
  return {
    measuredAt: new Date().toISOString(),
    cpuPercent,
    memoryUsedMb,
    memoryAvailableMb: free(memoryUsedMb, memoryTotalMb),
    diskUsedMb,
    diskTotalMb,
    diskAvailableMb: free(diskUsedMb, diskTotalMb),
  };
}

/** Read the persisted, owned host; never provision/resume it or use master
 * credentials for its stream. The outer operation reauthorizes every sample. */
export async function* streamCloudResourceUsage(
  organizationId: string,
  serverId: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const server = await repos.server.getInOrganization(serverId, organizationId);
  if (!server) throw new NotFoundError("Server", serverId);
  if (!server.workspaceId)
    throw new AppError(
      "Live resource usage is available for Cloud spaces only",
      409,
      "MANAGED_RESOURCE_REQUIRED",
    );
  const { client, binding, provider } = await readCloudWorkspaceConnection(
    organizationId,
    server.workspaceId,
  );
  signal?.throwIfAborted();
  if (!["running", "active"].includes(cloudWorkspaceStatus(provider.workspace)))
    throw new AppError(
      "This Cloud space is not running. Live usage is unavailable.",
      409,
      "CLOUD_WORKSPACE_NOT_RUNNING",
    );
  for await (const raw of client.streamWorkspaceMetrics(binding.workspaceId!, signal)) {
    signal?.throwIfAborted();
    yield { event: "usage", data: JSON.stringify(normalizeResourceUsage(raw)) };
  }
}
