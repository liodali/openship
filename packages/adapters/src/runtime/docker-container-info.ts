import type { ContainerInfo } from "../types";
import type { DockerContainerSummary, DockerPortBinding } from "./types";
import type Dockerode from "dockerode";
import type { ContainerStabilitySample } from "./stability";
import type { DiscoveryContainerView, DiscoveryNetworkFact, DiscoveryPublishedPortFact } from "@repo/core";

/** Shared inspect normalization for deployment stability and environment Apply. */
export function stabilitySampleFromDockerInspect(data: Dockerode.ContainerInspectInfo): ContainerStabilitySample {
  const rawState = (data.State?.Status ?? "").toLowerCase().trim();
  let state: ContainerStabilitySample["state"] = "unknown";
  if ((["created", "running", "restarting", "paused", "exited", "dead", "removing"] as const).includes(rawState as never)) {
    state = rawState as ContainerStabilitySample["state"];
  } else if (!rawState) {
    if (data.State?.Paused) state = "paused";
    else if (data.State?.Restarting) state = "restarting";
    else if (data.State?.Running) state = "running";
    else if (data.State?.Running === false) state = "exited";
  }
  const rawHealth = (data.State?.Health?.Status ?? "").toLowerCase().trim();
  const health = rawHealth === "healthy" || rawHealth === "unhealthy" || rawHealth === "starting" ? rawHealth : null;
  return {
    state,
    exitCode: typeof data.State?.ExitCode === "number" ? data.State.ExitCode : null,
    restartCount: typeof data.RestartCount === "number" ? data.RestartCount : 0,
    health,
    errorLine: data.State?.Error?.trim() ? data.State.Error.trim() : null,
    oomKilled: data.State?.OOMKilled === true,
    restartPolicy: data.HostConfig?.RestartPolicy?.Name ?? null,
  };
}

/** Docker keeps Running=true while paused or restarting. Those flags, and an
 * unhealthy verdict, take precedence in both inventory and individual reads. */
export function dockerContainerStatus(
  rawState: string,
  details: { running?: boolean; paused?: boolean; restarting?: boolean; health?: string; statusLine?: string } = {},
): ContainerInfo["status"] {
  const state = rawState.toLowerCase().trim();
  if (details.paused || state === "paused") return "stopped";
  if (details.restarting || state === "restarting" || state === "starting") return "deploying";
  if (state === "dead" || state === "unhealthy" || details.health?.toLowerCase() === "unhealthy" ||
      /\(unhealthy\)/i.test(details.statusLine ?? "")) return "failed";
  if (details.running || state === "running" || state === "healthy") return "running";
  return "stopped";
}

function bindingPriority(ip: string | undefined): number {
  const normalized = ip?.trim().replace(/^\[|\]$/g, "") ?? "";
  if (normalized === "127.0.0.1" || normalized === "::1") return 3;
  if (/^127(?:\.\d{1,3}){3}$/.test(normalized)) return 2;
  if (normalized && normalized !== "0.0.0.0" && normalized !== "::") return 1;
  return 0;
}

/**
 * Normalize Docker's published-port rows into the runtime's durable mapping.
 *
 * Docker can report several host bindings for one container port. Routes must
 * prefer the loopback binding Openship owns instead of depending on daemon
 * array order. Kept here so list and inspect paths cannot drift.
 */
export function dockerPublishedPortInfo(
  ports: readonly DockerPortBinding[],
): Pick<ContainerInfo, "hostPort" | "hostPortByContainerPort"> {
  const selected = new Map<number, { hostPort: number; priority: number }>();
  for (const binding of ports) {
    if ((binding.type || "tcp").toLowerCase() !== "tcp") continue;
    if (
      !Number.isSafeInteger(binding.privatePort) ||
      binding.privatePort < 1 ||
      binding.privatePort > 65_535
    ) {
      continue;
    }
    const hostPort = binding.publicPort;
    if (
      typeof hostPort !== "number" ||
      !Number.isSafeInteger(hostPort) ||
      hostPort < 1 ||
      hostPort > 65_535
    ) {
      continue;
    }
    const priority = bindingPriority(binding.ip);
    const previous = selected.get(binding.privatePort);
    if (!previous || priority > previous.priority) {
      selected.set(binding.privatePort, { hostPort, priority });
    }
  }

  const hostPortByContainerPort = Object.fromEntries(
    [...selected].map(([containerPort, binding]) => [containerPort, binding.hostPort]),
  );
  const hostPort = selected.values().next().value?.hostPort;
  return {
    ...(hostPort !== undefined ? { hostPort } : {}),
    ...(selected.size > 0 ? { hostPortByContainerPort } : {}),
  };
}

/** Convert a one-shot `docker ps -a` row into the standard runtime view. */
export function containerInfoFromDockerSummary(container: DockerContainerSummary): ContainerInfo {
  return {
    containerId: container.id,
    // Retention compares immutable identity, never a mutable image tag.
    ...(container.imageId ? { imageId: container.imageId } : {}),
    status: dockerContainerStatus(container.state, { statusLine: container.status }),
    ...(container.ip ? { ip: container.ip } : {}),
    ...dockerPublishedPortInfo(container.ports),
  };
}

/**
 * Discovery scanner view of one container, from a single inspect
 * (docs/docker-service-discovery-plan.md, step 2).
 *
 * Three jobs the generic reads don't do:
 *  1. Keep the PER-NETWORK map (name → id + IPv4), so the reconciler routes to
 *     the address ON the selected network; "first IP across networks" is exactly
 *     the guessing discovery must not do on multi-network hosts.
 *  2. Filter env to OPENSHIP_* and labels to openship/compose/io.openship
 *     namespaces — the caller's memory and logs hold only discovery fields,
 *     never the app's DATABASE_URL.
 *  3. Report the fresh `State.Running` flag — the certificate lifecycle's
 *     eligibility gate reads THIS, not a cached status.
 *
 * Network drivers are NOT in the per-container inspect payload; callers enrich
 * them from the host network list before handing the view to the parser, whose
 * usability rule fails closed on an unknown driver.
 */
export function discoveryContainerViewFromDockerInspect(
  data: Dockerode.ContainerInspectInfo,
  containerId: string,
): DiscoveryContainerView {
  const labels = data.Config?.Labels ?? {};
  const env: string[] = [];
  for (const entry of data.Config?.Env ?? []) {
    if (entry.startsWith("OPENSHIP_")) env.push(entry);
  }
  const discoveryLabels: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    if (
      key.startsWith("openship.") ||
      key.startsWith("io.openship.") ||
      key.startsWith("com.docker.compose.")
    ) {
      discoveryLabels[key] = value;
    }
  }
  const networks: DiscoveryNetworkFact[] = Object.entries(
    data.NetworkSettings?.Networks ?? {},
  ).map(([name, endpoint]) => ({
    name,
    id: endpoint?.NetworkID || undefined,
    // IPv4 only in the first release; IPv6 addressing is follow-up work.
    ipAddress: endpoint?.IPAddress || undefined,
  }));
  // Observed TCP published bindings (discovery plan, rootless path): only LIVE
  // concrete bindings with a real host port count — exposed-but-unpublished
  // ports and UDP are never upstream candidates. Both the live table (running
  // containers) and the retained declaration (stopped) are read the same way
  // `extractNetworkInfo` reads them for routes.
  const nsPorts = (data.NetworkSettings?.Ports ?? {}) as Record<
    string,
    Array<{ HostIp?: string; HostPort?: string }> | null
  >;
  const publishedPorts: DiscoveryPublishedPortFact[] = [];
  for (const [key, bindings] of Object.entries(nsPorts)) {
    const [portStr, proto = "tcp"] = key.split("/");
    if (proto !== "tcp") continue;
    const containerPort = Number(portStr);
    if (!Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65535) continue;
    for (const binding of bindings ?? []) {
      const hostPort = Number(binding?.HostPort);
      if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535) continue;
      publishedPorts.push({
        ...(binding?.HostIp ? { hostIp: binding.HostIp } : {}),
        hostPort,
        containerPort,
      });
    }
  }

  return {
    containerId,
    name: (data.Name ?? "").replace(/^\//, "") || undefined,
    image: data.Config?.Image ?? undefined,
    status: dockerContainerStatus(data.State?.Status ?? "", {
      running: data.State?.Running,
      paused: data.State?.Paused,
      restarting: data.State?.Restarting,
      health: data.State?.Health?.Status,
    }),
    running: data.State?.Running === true,
    env,
    labels: discoveryLabels,
    networks,
    publishedPorts,
  };
}
