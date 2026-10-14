import type { ResourceConfig } from "@repo/adapters";
import type { CloudWorkspaceUsage } from "@repo/contracts";

/** Only CPU and memory are reserved. Disk capacity is not free disk space. */
export type CloudBuildReservation = Readonly<Pick<ResourceConfig, "cpuCores" | "memoryMb">>;
export type CloudBuildResourceUsage = Readonly<
  Pick<CloudWorkspaceUsage, "available" | "memoryAvailableMb" | "cpuPercent">
>;

export interface CloudBuildResourceInput {
  capacity: CloudBuildReservation;
  /** Explicit limits need a fresh sample. Uncapped builds need no usage sample. */
  usage: CloudBuildResourceUsage | null;
  /** All outstanding reservations on this host, excluding this candidate. */
  reservations: readonly CloudBuildReservation[];
  /** Missing or zero dimensions mean no Docker cap, as in saved settings. */
  requested?: Readonly<Partial<CloudBuildReservation>> | null;
  /** Validate the plan ceiling; admission slots remain owned by the caller.
   * It must not divide or cap the resources of an automatic build. */
  concurrencyLimit?: number | null;
}

export type CloudBuildResourceDecision =
  | { kind: "admit"; resources: ResourceConfig }
  | {
      kind: "wait";
      reason:
        | "capacity-unavailable"
        | "usage-unavailable"
        | "reservations-unavailable"
        | "concurrency-unavailable"
        | "memory-pressure"
        | "cpu-pressure";
    }
  | {
      kind: "impossible";
      reason: "invalid-request" | "memory-exceeds-capacity" | "cpu-exceeds-capacity";
    };

const MIN_MEMORY_MB = 128;
const MIN_CPU_CORES = 0.25;
const finiteNonnegative = (value: number) => Number.isFinite(value) && value >= 0;

/** Admission ledger only; never a Docker resource configuration. Missing limits
 * reserve the full host dimension so uncapped builds do not overlap siblings.
 * Fully automatic builds need only verified host capacity, not a usage sample.
 * Explicit caps remain unchanged and use live usage for admission. */
export function decideCloudBuildResources(
  input: CloudBuildResourceInput,
): CloudBuildResourceDecision {
  const { capacity, usage, reservations, requested, concurrencyLimit } = input;
  const cpu = requested?.cpuCores ?? 0;
  const memory = requested?.memoryMb ?? 0;
  if (
    !finiteNonnegative(cpu) ||
    !finiteNonnegative(memory) ||
    (cpu > 0 && cpu < MIN_CPU_CORES) ||
    (memory > 0 && memory < MIN_MEMORY_MB)
  ) {
    return { kind: "impossible", reason: "invalid-request" };
  }
  if (
    !Number.isFinite(capacity.cpuCores) ||
    capacity.cpuCores <= 0 ||
    !Number.isFinite(capacity.memoryMb) ||
    capacity.memoryMb <= 0
  ) {
    return { kind: "wait", reason: "capacity-unavailable" };
  }

  const headroomMb = Math.min(512, Math.max(128, capacity.memoryMb * 0.05));
  const memoryBudget = Math.floor(capacity.memoryMb - headroomMb);
  // Structural impossibility is independent of live usage and other reservations.
  if (memoryBudget < MIN_MEMORY_MB || memory > memoryBudget)
    return { kind: "impossible", reason: "memory-exceeds-capacity" };
  if (capacity.cpuCores < MIN_CPU_CORES || cpu > capacity.cpuCores)
    return { kind: "impossible", reason: "cpu-exceeds-capacity" };

  if (
    concurrencyLimit != null &&
    (!Number.isSafeInteger(concurrencyLimit) || concurrencyLimit <= 0)
  )
    return { kind: "wait", reason: "concurrency-unavailable" };
  let reservedMemory = 0;
  let reservedCpu = 0;
  for (const reservation of reservations) {
    // Zero is not a bounded reservation. A corrupt ledger must fail closed.
    if (
      !Number.isFinite(reservation.memoryMb) ||
      reservation.memoryMb <= 0 ||
      !Number.isFinite(reservation.cpuCores) ||
      reservation.cpuCores <= 0
    )
      return { kind: "wait", reason: "reservations-unavailable" };
    reservedMemory += reservation.memoryMb;
    reservedCpu += reservation.cpuCores;
  }
  if (!Number.isFinite(reservedMemory) || !Number.isFinite(reservedCpu))
    return { kind: "wait", reason: "reservations-unavailable" };

  const reservationCpu = cpu || capacity.cpuCores;
  const reservationMemory = memory || memoryBudget;
  const tolerance = Number.EPSILON * capacity.cpuCores * (reservations.length + 2);
  if (reservationMemory > memoryBudget - reservedMemory)
    return { kind: "wait", reason: "memory-pressure" };
  if (reservationCpu - (capacity.cpuCores - reservedCpu) > tolerance)
    return { kind: "wait", reason: "cpu-pressure" };
  if (cpu || memory) {
    if (
      !usage?.available ||
      usage.memoryAvailableMb === null ||
      usage.cpuPercent === null ||
      !finiteNonnegative(usage.memoryAvailableMb) ||
      !finiteNonnegative(usage.cpuPercent) ||
      usage.cpuPercent > 100
    ) {
      return { kind: "wait", reason: "usage-unavailable" };
    }
    const freeMemory =
      Math.floor(Math.min(capacity.memoryMb, usage.memoryAvailableMb) - headroomMb) -
      reservedMemory;
    if (freeMemory < MIN_MEMORY_MB || memory > freeMemory)
      return { kind: "wait", reason: "memory-pressure" };
    if (usage.cpuPercent >= 95) return { kind: "wait", reason: "cpu-pressure" };
  }
  return {
    kind: "admit",
    resources: { cpuCores: reservationCpu, memoryMb: reservationMemory, diskMb: 0 },
  };
}
