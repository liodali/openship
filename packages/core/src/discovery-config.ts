/**
 * Docker service discovery — pure opt-in declaration parser (discovery plan step 2).
 *
 * A container tells Openship "discover me" through environment variables and/or
 * Docker labels (see docs/docker-service-discovery-plan.md). This module turns raw
 * container facts — `Config.Env`, `Config.Labels`, Compose identity labels, and the
 * networks the container is actually attached to — into one deterministic
 * normalized declaration, or a structured rejection explaining exactly why.
 *
 * Rules enforced here (nothing else may relax them):
 *  - Explicit opt-in: absent/false means undiscovered. No other signal counts.
 *  - Openship-owned containers (control-plane, Edge, build/helper, managed apps)
 *    are never candidates — a declaration on one is ignored, not applied.
 *  - Env and label may coexist only when they AGREE; disagreement is a conflict,
 *    never a precedence game. Compose already interpolated `${VARS}` before we read.
 *  - Hostname and container port are required; the port is the declared integer,
 *    1–65535. Nothing is guessed from EXPOSE, published mappings, or heuristics.
 *  - Stable identity comes from an explicit service id, or Compose project +
 *    service labels. Standalone containers without Compose identity MUST declare
 *    an explicit id. Containers cannot choose organization/workspace/project.
 *  - Network selection resolves an explicit selector by its ACTUAL Docker network
 *    name (never a Compose YAML alias). Without a selector exactly one usable
 *    user-defined bridge network must be attached; several or none is an error,
 *    and host/none/default-bridge are unusable in the first release.
 *
 * Pure by design: no Docker calls, no database, no clock. The scanner feeds facts
 * from `docker inspect` and gets the same answer for the same container every time.
 */

import { ValidationError } from "./errors";

// ─── Configuration surface ───────────────────────────────────────────────────

/** Environment variables a container sets to opt in. Keep label keys in sync. */
export const DISCOVERY_ENV = {
  discovery: "OPENSHIP_DISCOVERY",
  serviceId: "OPENSHIP_SERVICE_ID",
  domain: "OPENSHIP_DOMAIN",
  port: "OPENSHIP_PORT",
  network: "OPENSHIP_NETWORK",
} as const;

/** Docker labels equivalent to {@link DISCOVERY_ENV}. Overlapping keys must agree. */
export const DISCOVERY_LABEL = {
  discovery: "openship.discovery",
  serviceId: "openship.service.id",
  domain: "openship.domain",
  port: "openship.port",
  network: "openship.network",
} as const;

/**
 * Labels that mark a container as owned by Openship itself. Containers carrying
 * any of these are excluded from discovery: the control-plane, Edge, build and
 * helper containers must never route to themselves, and already-managed
 * application containers keep their existing (project-owned) route owners —
 * discovery never competes for them in the first release. Mirrors the labels
 * `DockerRuntime.labels()` / the Edge container actually stamp.
 */
export const OPENSIP_OWNERSHIP_LABELS = [
  "openship.project",
  "openship.deployment",
  "openship.service",
  "openship.build",
  "openship.role",
  "io.openship.managed-node-listener",
] as const;

/** Compose identity labels, read straight from inspect (never from compose files). */
export const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";
export const COMPOSE_SERVICE_LABEL = "com.docker.compose.service";

/** Valid explicit service id after lowercasing: what compose projects allow, roughly. */
const SERVICE_ID_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,62}$/;

/**
 * Public hostname a discovered service may claim. Same shape as the custom-domain
 * contract pattern MINUS the wildcard prefix — wildcard domains are follow-up work,
 * and a bare TLD or path-looking value is never a routeable hostname.
 */
const HOSTNAME_PATTERN = /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
const HOSTNAME_MAX_LENGTH = 253;

/** Docker's pre-created default bridge: driver bridge, but not user-defined. */
const DEFAULT_BRIDGE_NETWORK = "bridge";

// ─── Inputs ──────────────────────────────────────────────────────────────────

/** One network the container is attached to, as reported by inspect. */
export interface DiscoveryNetworkFact {
  /** Actual Docker network name — NOT a Compose YAML alias. */
  name: string;
  /** Network driver, e.g. "bridge", "host", "null", "overlay". */
  driver?: string | null;
  /** Docker network id when the caller has it; carried through, never required. */
  id?: string | null;
  /** Container IPv4 address ON this network, when reported (running containers). */
  ipAddress?: string | null;
}

/** Raw container facts the parser needs. All optional — inspect can omit anything.
 *  Field names match `DiscoveryContainerView`, so a runtime view feeds the parser directly. */
export interface DiscoveryCandidateInput {
  /** `Config.Env` — "KEY=VALUE" strings. */
  env?: string[] | null;
  /** `Config.Labels`. */
  labels?: Record<string, string> | null;
  /** Networks the container is ACTUALLY attached to (`NetworkSettings.Networks`). */
  networks?: DiscoveryNetworkFact[] | null;
}

// ─── Outputs ─────────────────────────────────────────────────────────────────

/** A validated, normalized discovery declaration for one container. */
export interface DiscoveryDeclaration {
  /**
   * Stable identity scoped to the server. `id:<serviceId>` for explicit ids,
   * `compose:<project>/<service>` for Compose-derived identity. Unique per server;
   * replacements (recreate, restart, IP change) keep the key.
   */
  serviceKey: string;
  /** Explicit service id, when that is the identity source. */
  serviceId?: string;
  /** Compose project label, when Compose identity is used. Display grouping only. */
  composeProject?: string;
  /** Compose service label, when Compose identity is used. */
  composeService?: string;
  /** Lowercased public hostname the service claims. */
  hostname: string;
  /** Declared container port, 1–65535. */
  port: number;
  /** Selected network: actual Docker name. */
  network: string;
  /** Docker network id, when known. */
  networkId?: string;
}

/** Why a container is not a discovery candidate, machine-readable for status UI. */
export type DiscoveryRejection =
  | { kind: "not-opted-in" }
  | { kind: "excluded"; label: string }
  | { kind: "invalid"; code: DiscoveryErrorCode; message: string };

export type DiscoveryErrorCode =
  | "invalid-discovery-flag"
  | "conflict"
  | "missing-domain"
  | "invalid-domain"
  | "missing-port"
  | "invalid-port"
  | "identity-required"
  | "compose-identity-partial"
  | "invalid-service-id"
  | "networks-unknown"
  | "network-missing"
  | "network-unusable"
  | "network-ambiguous";

/** Result of parsing one container: either a declaration or an explained rejection. */
export type DiscoveryParseResult =
  | { eligible: true; declaration: DiscoveryDeclaration }
  | { eligible: false; rejection: DiscoveryRejection };

/**
 * One container as the discovery scanner sees it, produced by the runtime adapter
 * from a single inspect. Deliberately NARROW: env is pre-filtered to OPENSHIP_* variables and labels to
 * the openship/compose namespaces, so application secrets
 * never enter discovery memory or logs — the full inspect is dropped at the source.
 */
export interface DiscoveryContainerView {
  containerId: string;
  /** Container name without the leading slash. */
  name?: string | null;
  image?: string | null;
  /** Normalized status, same vocabulary as `ContainerInfo.status` ("running", ...). */
  status: string;
  /** Fresh `State.Running` from THIS inspection — the ACME eligibility gate. */
  running: boolean;
  /** `Config.Env` filtered to OPENSHIP_* keys ("K=V" strings). */
  env: string[];
  /** Labels filtered to openship/compose/io.openship namespaces. */
  labels: Record<string, string>;
  /** Networks actually attached, with id and IPv4 address per network. */
  networks: DiscoveryNetworkFact[];
}

// ─── Network usability ───────────────────────────────────────────────────────

/**
 * Can this network carry discovered-service traffic? First release: user-defined
 * bridge networks only, and the caller must supply the REAL driver — the
 * per-container inspect view does not carry drivers, so callers enrich from the
 * host network list ({@link DiscoveryContainerView} producers do this). Unknown
 * driver means "not proven usable": discovery fails visibly instead of routing
 * over a network the Edge may not be able to reach. The default `bridge` network,
 * host, none (`null` driver), macvlan and overlays are never usable.
 */
export function isUsableDiscoveryNetwork(net: Pick<DiscoveryNetworkFact, "name" | "driver">): boolean {
  if (!net.name) return false;
  if (net.name === DEFAULT_BRIDGE_NETWORK) return false;
  return net.driver === "bridge";
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

const BOOLEAN_TRUE = new Set(["true", "1"]);
const BOOLEAN_FALSE = new Set(["false", "0", ""]);

/** Parse one boolean flag collected from env/label. Empty string counts as unset-false. */
function parseDiscoveryFlag(raw: string): boolean | string {
  const value = raw.trim().toLowerCase();
  if (BOOLEAN_TRUE.has(value)) return true;
  if (BOOLEAN_FALSE.has(value)) return false;
  return `must be "true" or "false", got ${JSON.stringify(raw.trim())}`;
}

function parsePort(raw: string): number | string {
  const value = raw.trim();
  if (!/^\d{1,5}$/.test(value)) return `must be an integer, got ${JSON.stringify(raw.trim())}`;
  const port = Number(value);
  if (port < 1 || port > 65535) return `must be between 1 and 65535, got ${port}`;
  return port;
}

/** Collect one config field from env and labels; disagreement is a conflict. */
function mergeField(
  fieldName: string,
  envValue: string | undefined,
  labelValue: string | undefined,
): { value?: string; error?: { code: DiscoveryErrorCode; message: string } } {
  const env = envValue?.trim();
  const label = labelValue?.trim();
  const hasEnv = env != null && env !== "";
  const hasLabel = label != null && label !== "";
  if (hasEnv && hasLabel && env !== label) {
    return {
      error: {
        code: "conflict",
        message: `${fieldName} is declared twice with different values: ${DISCOVERY_ENV[fieldName as keyof typeof DISCOVERY_ENV] ?? fieldName}=${JSON.stringify(env)} vs ${DISCOVERY_LABEL[fieldName as keyof typeof DISCOVERY_LABEL] ?? fieldName}=${JSON.stringify(label)}. Recreate the container with one agreed value.`,
      },
    };
  }
  if (hasEnv) return { value: env };
  if (hasLabel) return { value: label };
  return {};
}

/**
 * Parse one container's discovery declaration.
 *
 * Never throws for a candidate's own configuration problems — a scanner walks
 * hundreds of containers and needs per-container outcomes, not an early abort.
 * Returns `eligible: false` with a machine-readable rejection instead. Only a
 * malformed CALLER input (non-string env entry) raises {@link ValidationError}.
 */
export function parseDiscoveryDeclaration(input: DiscoveryCandidateInput): DiscoveryParseResult {
  const labels = input.labels ?? {};
  const envPairs = new Map<string, string>();
  for (const entry of input.env ?? []) {
    if (typeof entry !== "string") {
      throw new ValidationError("discovery candidate env entries must be strings");
    }
    const eq = entry.indexOf("=");
    if (eq <= 0) continue; // odd but harmless; not ours to interpret
    envPairs.set(entry.slice(0, eq), entry.slice(eq + 1));
  }

  // Openship-owned containers are never candidates, opted in or not.
  for (const owned of OPENSIP_OWNERSHIP_LABELS) {
    if (labels[owned] != null && labels[owned] !== "") {
      return { eligible: false, rejection: { kind: "excluded", label: owned } };
    }
  }

  // Opt-in flag, from env and/or label. Absent/false → undiscovered, quietly.
  const flag = mergeField("discovery", envPairs.get(DISCOVERY_ENV.discovery), labels[DISCOVERY_LABEL.discovery]);
  if (flag.error) {
    return { eligible: false, rejection: { kind: "invalid", ...flag.error } };
  }
  if (flag.value == null) return { eligible: false, rejection: { kind: "not-opted-in" } };
  const optedIn = parseDiscoveryFlag(flag.value);
  if (typeof optedIn === "string") {
    return {
      eligible: false,
      rejection: {
        kind: "invalid",
        code: "invalid-discovery-flag",
        message: `${DISCOVERY_ENV.discovery}/${DISCOVERY_LABEL.discovery} ${optedIn}.`,
      },
    };
  }
  if (!optedIn) return { eligible: false, rejection: { kind: "not-opted-in" } };

  // Hostname: required, normalized, same shape as custom-domain inputs.
  const domain = mergeField("domain", envPairs.get(DISCOVERY_ENV.domain), labels[DISCOVERY_LABEL.domain]);
  if (domain.error) return { eligible: false, rejection: { kind: "invalid", ...domain.error } };
  if (domain.value == null) {
    return {
      eligible: false,
      rejection: {
        kind: "invalid",
        code: "missing-domain",
        message: `Set ${DISCOVERY_ENV.domain} (env) or ${DISCOVERY_LABEL.domain} (label) to the public hostname this service claims.`,
      },
    };
  }
  const hostname = domain.value.trim().toLowerCase();
  if (!HOSTNAME_PATTERN.test(hostname) || hostname.length > HOSTNAME_MAX_LENGTH) {
    return {
      eligible: false,
      rejection: {
        kind: "invalid",
        code: "invalid-domain",
        message: `${JSON.stringify(domain.value)} is not a valid public hostname. Use a DNS name like app.example.com; wildcards are not supported yet.`,
      },
    };
  }

  // Port: required, strict integer 1–65535. No guessing.
  const portField = mergeField("port", envPairs.get(DISCOVERY_ENV.port), labels[DISCOVERY_LABEL.port]);
  if (portField.error) return { eligible: false, rejection: { kind: "invalid", ...portField.error } };
  if (portField.value == null) {
    return {
      eligible: false,
      rejection: {
        kind: "invalid",
        code: "missing-port",
        message: `Set ${DISCOVERY_ENV.port} (env) or ${DISCOVERY_LABEL.port} (label) to the container port your app listens on.`,
      },
    };
  }
  const port = parsePort(portField.value);
  if (typeof port === "string") {
    return {
      eligible: false,
      rejection: { kind: "invalid", code: "invalid-port", message: `${DISCOVERY_ENV.port} ${port}.` },
    };
  }

  // Stable identity: explicit id first, else Compose project+service.
  const serviceIdField = mergeField(
    "serviceId",
    envPairs.get(DISCOVERY_ENV.serviceId),
    labels[DISCOVERY_LABEL.serviceId],
  );
  if (serviceIdField.error) return { eligible: false, rejection: { kind: "invalid", ...serviceIdField.error } };
  const composeProject = labels[COMPOSE_PROJECT_LABEL]?.trim();
  const composeService = labels[COMPOSE_SERVICE_LABEL]?.trim();
  let serviceKey: string;
  let declaration: Omit<DiscoveryDeclaration, "serviceKey" | "hostname" | "port" | "network" | "networkId"> & {
    hostname: string;
    port: number;
  };
  if (serviceIdField.value != null) {
    const serviceId = serviceIdField.value.trim().toLowerCase();
    if (!SERVICE_ID_PATTERN.test(serviceId)) {
      return {
        eligible: false,
        rejection: {
          kind: "invalid",
          code: "invalid-service-id",
          message: `${DISCOVERY_ENV.serviceId} ${JSON.stringify(serviceIdField.value)} must be 1–63 letters, digits, dots, dashes or underscores.`,
        },
      };
    }
    serviceKey = `id:${serviceId}`;
    // Compose labels remain informational (UI grouping) even when an explicit
    // id owns the identity — the key is the id, the grouping is the stack.
    declaration = {
      serviceId,
      ...(composeProject ? { composeProject } : {}),
      ...(composeService ? { composeService } : {}),
      hostname,
      port,
    };
  } else if (composeProject && composeService) {
    serviceKey = `compose:${composeProject}/${composeService}`;
    declaration = { composeProject, composeService, hostname, port };
  } else if (composeProject || composeService) {
    return {
      eligible: false,
      rejection: {
        kind: "invalid",
        code: "compose-identity-partial",
        message: `Container has only one of the Compose project/service labels. Standalone containers must set ${DISCOVERY_ENV.serviceId} or ${DISCOVERY_LABEL.serviceId}.`,
      },
    };
  } else {
    return {
      eligible: false,
      rejection: {
        kind: "invalid",
        code: "identity-required",
        message: `No Compose identity and no explicit id. Set ${DISCOVERY_ENV.serviceId} (env) or ${DISCOVERY_LABEL.serviceId} (label) so replacements keep the same identity.`,
      },
    };
  }

  // Network: explicit selector resolved by ACTUAL name, else the single usable bridge.
  const networkField = mergeField(
    "network",
    envPairs.get(DISCOVERY_ENV.network),
    labels[DISCOVERY_LABEL.network],
  );
  if (networkField.error) return { eligible: false, rejection: { kind: "invalid", ...networkField.error } };
  const attached = input.networks ?? null;
  if (attached == null) {
    return {
      eligible: false,
      rejection: {
        kind: "invalid",
        code: "networks-unknown",
        message: "Container network membership could not be read; discovery cannot pick a route-safe network.",
      },
    };
  }
  const selector = networkField.value?.trim();
  let selected: DiscoveryNetworkFact | undefined;
  if (selector) {
    // Exact name, never an alias — then the SAME usability rule as the
    // auto-selected path. A selector is a choice, not an exemption: host,
    // default bridge and overlay networks are exactly the ones an operator is
    // most likely to name explicitly, and the Edge cannot reach them the way
    // it reaches a user-defined bridge.
    selected = attached.find((net) => net.name === selector); // exact name, never an alias
    if (!selected) {
      return {
        eligible: false,
        rejection: {
          kind: "invalid",
          code: "network-missing",
          message: `Network "${selector}" is not attached to this container. Attached: ${attached.map((n) => n.name || "(unnamed)").join(", ") || "none"}.`,
        },
      };
    }
    if (!isUsableDiscoveryNetwork(selected)) {
      return {
        eligible: false,
        rejection: {
          kind: "invalid",
          code: "network-unusable",
          message: `Network "${selector}" is not a user-defined bridge network${selected.driver && selected.driver !== "bridge" ? ` (driver: ${selected.driver})` : selected.name === DEFAULT_BRIDGE_NETWORK ? " (Docker's default bridge)" : ""} and cannot carry discovered-service traffic. Attach a user-defined bridge or pick one with ${DISCOVERY_ENV.network}.`,
        },
      };
    }
  } else {
    const usable = attached.filter((net) => isUsableDiscoveryNetwork(net));
    if (usable.length === 0) {
      return {
        eligible: false,
        rejection: {
          kind: "invalid",
          code: "network-unusable",
          message: `No usable user-defined bridge network attached. Attached: ${attached.map((n) => `${n.name || "(unnamed)"}${n.driver && n.driver !== "bridge" ? ` (${n.driver})` : ""}`).join(", ") || "none"}. Attach one or set ${DISCOVERY_ENV.network}.`,
        },
      };
    }
    if (usable.length > 1) {
      return {
        eligible: false,
        rejection: {
          kind: "invalid",
          code: "network-ambiguous",
          message: `Several usable networks attached (${usable.map((n) => n.name).join(", ")}). Set ${DISCOVERY_ENV.network} to pick one.`,
        },
      };
    }
    selected = usable[0];
  }

  return {
    eligible: true,
    declaration: {
      ...declaration,
      serviceKey,
      network: selected.name,
      ...(selected.id ? { networkId: selected.id } : {}),
    },
  };
}

// ─── Identity conflicts across containers ────────────────────────────────────

/**
 * Group eligible declarations by stable identity. Every key mapping to more than
 * one LIVE container is a conflict: discovery refuses to pick a replica and the
 * operator must resolve the duplicate (scale to one, or give each an explicit id)
 * before any route is written. Callers pass only the currently-running eligible
 * declarations for one server.
 */
export function findDuplicateDiscoveryIdentities(
  declarations: DiscoveryDeclaration[],
): Map<string, DiscoveryDeclaration[]> {
  const byKey = new Map<string, DiscoveryDeclaration[]>();
  for (const declaration of declarations) {
    const existing = byKey.get(declaration.serviceKey);
    if (existing) existing.push(declaration);
    else byKey.set(declaration.serviceKey, [declaration]);
  }
  return new Map([...byKey].filter(([, group]) => group.length > 1));
}

// ─── Config hash ─────────────────────────────────────────────────────────────

/**
 * Deterministic change fingerprint of a declaration's desired config (hostname,
 * port, network). The reconciler stores this on the binding: a rescan that hashes
 * the same proves the container config is unchanged, while a different hash says
 * "the operator recreated the container with new config — re-apply desired state".
 * Dependency-free FNV-1a is plenty: this is change detection between two scans of
 * the same identity, not a security primitive.
 */
export function discoveryConfigHash(declaration: Pick<DiscoveryDeclaration, "hostname" | "port" | "network">): string {
  const canonical = JSON.stringify([declaration.hostname, declaration.port, declaration.network]);
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
