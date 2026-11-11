import { isIP } from "node:net";
import {
  discoveryConfigHash,
  parseDiscoveryDeclaration,
  type DiscoveryDeclaration,
  type DiscoveryUpstreamCandidate,
} from "@repo/core";
import type { RuntimeAdapter, RoutingProvider } from "@repo/adapters";
import type { DiscoveryBinding } from "@repo/db";

export type DiscoveryInspectionRuntime = Pick<RuntimeAdapter, "getDiscoveryContainerView" | "listAllNetworks">;
export type ResolvedDiscoveryTarget = Pick<DiscoveryBinding,
  "upstreamStrategy" | "ipAddress" | "hostPort" | "hostIp">;

export interface ReachableDiscoveryUpstream {
  candidate: DiscoveryUpstreamCandidate;
  targetUrl: string;
  target: ResolvedDiscoveryTarget;
}

function endpoint(candidate: DiscoveryUpstreamCandidate, port: number) {
  const raw = candidate.kind === "bridge-ip" ? candidate.ipAddress : candidate.hostIp;
  if (candidate.kind === "bridge-ip" && (!raw || raw === "0.0.0.0" || raw === "::")) {
    throw new Error("Engine reported an invalid bridge IP address");
  }
  // A wildcard bind is not a destination. Its loopback candidate must actually
  // answer from Edge; an API-host connection cannot authorize it.
  const host = raw === "::" ? "::1" : !raw || raw === "0.0.0.0" ? "127.0.0.1" : raw;
  if (!isIP(host) || (candidate.kind === "bridge-ip" && (host === "0.0.0.0" || host === "::"))) {
    throw new Error("Engine reported an invalid upstream IP address");
  }
  const targetPort = candidate.kind === "bridge-ip" ? port : candidate.hostPort;
  return { host, port: targetPort, url: `http://${host.includes(":") ? `[${host}]` : host}:${targetPort}` };
}

export function discoveryTarget(candidate: DiscoveryUpstreamCandidate): ResolvedDiscoveryTarget {
  return candidate.kind === "bridge-ip"
    ? { upstreamStrategy: "network-ip", ipAddress: candidate.ipAddress, hostPort: null, hostIp: null }
    : { upstreamStrategy: "published-port", ipAddress: null, hostPort: candidate.hostPort, hostIp: candidate.hostIp };
}

export function sameDiscoveryTarget(a: ResolvedDiscoveryTarget, b: ResolvedDiscoveryTarget): boolean {
  return a.upstreamStrategy === b.upstreamStrategy && a.ipAddress === b.ipAddress &&
    a.hostPort === b.hostPort && a.hostIp === b.hostIp;
}

/** Re-inspect the exact workload; never probe cached or sibling-port targets. */
export async function readLiveDiscoveryDeclaration(
  binding: DiscoveryBinding,
  runtime: DiscoveryInspectionRuntime | undefined,
): Promise<DiscoveryDeclaration> {
  if (!binding.containerId || !runtime?.getDiscoveryContainerView) {
    throw new Error("Discovery requires live container inspection before Edge routing");
  }
  const view = await runtime.getDiscoveryContainerView(binding.containerId);
  if (!view || !view.running || view.containerId !== binding.containerId) {
    throw new Error("Discovered container is no longer running; rescan before applying its route");
  }
  // Inspect does not include network drivers. Enrich on the same endpoint.
  const networks = view.networks.length ? await runtime.listAllNetworks?.() : [];
  if (!networks) throw new Error("Could not inspect discovery network drivers on the serving engine");
  const parsed = parseDiscoveryDeclaration({
    ...view,
    networks: view.networks.map((network) => ({
      ...network,
      driver: networks.find((n) => n.id === network.id || n.name === network.name)?.driver ?? null,
    })),
  });
  if (!parsed.eligible) {
    throw new Error(`Discovery declaration no longer valid (${parsed.rejection.kind}); rescan before routing`);
  }
  const declaration = parsed.declaration;
  if (declaration.serviceKey !== binding.serviceKey || declaration.hostname !== binding.hostname ||
      declaration.port !== binding.port || discoveryConfigHash(declaration) !== binding.configHash) {
    throw new Error("Discovery configuration changed during reconciliation; rescan before routing");
  }
  return declaration;
}

/** Choose only an endpoint reachable from the routing provider's own namespace. */
export async function resolveReachableDiscoveryUpstream(
  binding: DiscoveryBinding,
  runtime: DiscoveryInspectionRuntime | undefined,
  probe: RoutingProvider["probeUpstream"],
): Promise<ReachableDiscoveryUpstream> {
  if (!probe) throw new Error("The serving Edge cannot probe upstreams; update its routing provider");
  const declaration = await readLiveDiscoveryDeclaration(binding, runtime);
  const candidates = [...declaration.upstreams];
  // Keep a working resolved fallback stable on subsequent scans/retries.
  candidates.sort((a, b) => Number(sameDiscoveryTarget(discoveryTarget(b), binding)) -
    Number(sameDiscoveryTarget(discoveryTarget(a), binding)));
  const failures: string[] = [];
  for (const candidate of candidates.slice(0, 6)) {
    const address = endpoint(candidate, binding.port);
    const result = await probe(address.host, address.port);
    if (result.ok) return { candidate, targetUrl: address.url, target: discoveryTarget(candidate) };
    failures.push(`${address.url}: ${result.reason}`);
  }
  throw new Error(`No upstream reachable from Openship Edge (${failures.join("; ")}). ` +
    "Check the selected network or publish the declared container port where Edge can reach it" +
    (candidates.length > 6 ? "; probe limit reached (6 candidates)" : ""));
}

/** Close the probe/queue window before writing any route or reclaiming a bind. */
export async function assertDiscoveryUpstreamCurrent(
  binding: DiscoveryBinding,
  selected: ReachableDiscoveryUpstream,
  runtime: DiscoveryInspectionRuntime | undefined,
): Promise<void> {
  const current = await readLiveDiscoveryDeclaration(binding, runtime);
  if (!current.upstreams.some((c) => sameDiscoveryTarget(discoveryTarget(c), selected.target))) {
    throw new Error("Discovered upstream changed after its probe; retry from a fresh inventory");
  }
}
