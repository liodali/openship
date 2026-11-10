import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  foreignKey,
} from "drizzle-orm/pg-core";
import { servers } from "./servers";
import { cloudWorkspace } from "./cloud-workspace";

// ─── Docker service discovery (docs/docker-service-discovery-plan.md) ───────

/**
 * Per-server discovery settings. One row per server that has ever been
 * configured; absence of a row means "never configured" — the control-plane
 * boots no watcher and runs no sweeps for that host. Additive to `servers` on
 * purpose: the hot server row never carries discovery state, and disabling
 * discovery is a row write, not a schema rollback.
 *
 * Discovery is server-scoped by design: discovered services need neither an
 * Openship project nor a deployment. The workspace binding decides VISIBILITY
 * (which workspace's operators see the discovered services); containers cannot
 * choose it — only a trusted operator can, right here.
 */
export const discoverySettings = pgTable("discovery_settings", {
  /** The enabled server. Cascade: a removed server takes its settings with it. */
  serverId: text("server_id")
    .primaryKey()
    .references(() => servers.id, { onDelete: "cascade" }),

  /** Master switch. false pauses watchers and sweeps but RETAINS bindings. */
  enabled: boolean("enabled").notNull().default(false),

  /**
   * Visibility binding: the Cloud workspace whose operators can see this
   * server's discovered services. Null = organization-level visibility only.
   * Never derived from container configuration.
   */
  workspaceId: text("workspace_id").references(() => cloudWorkspace.id, {
    onDelete: "set null",
  }),

  /** Periodic repair sweep cadence. First release fixes this at 60s. */
  sweepIntervalSeconds: integer("sweep_interval_seconds").notNull().default(60),

  /** Last completed inventory, for status UI. Error text is sanitized upstream. */
  lastScanAt: timestamp("last_scan_at"),
  lastScanError: text("last_scan_error"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * One discovered service on one server, keyed by its STABLE identity
 * (`serviceKey` — `id:<serviceId>` or `compose:<project>/<service>`, minted by
 * the core parser). This row is the durable desired-state memory: container
 * replacements (new container id, new IP) update the observation and keep the
 * identity, so certificates, routes and history survive restarts.
 *
 * Deliberately NOT a project/service/deployment row. Discovered services are
 * their own server-scoped resources; nothing in the legacy APIs may fake one
 * into existence (docs step 3).
 *
 * Config lives HERE, not in the container, between scans: `hostname`, `port`,
 * `networkName/Id` are the last validated declaration, `configHash` is the
 * core parser's fingerprint — a rescan that hashes the same proves the
 * operator recreated the container with unchanged config and lets the
 * reconciler skip writes entirely.
 */
export const discoveryBinding = pgTable(
  "discovery_binding",
  {
    id: text("id")
      .primaryKey()
      .default(sql`'dsb_' || gen_random_uuid()::text`),

    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),

    /** Stable identity from the core parser. Unique per server. */
    serviceKey: text("service_key").notNull(),

    // ── Display-only grouping ────────────────────────────────────────────
    composeProject: text("compose_project"),
    composeService: text("compose_service"),

    // ── Desired config (last validated declaration) ──────────────────────
    /** Lowercased public hostname this service claims. */
    hostname: text("hostname").notNull(),
    /** Declared container port, 1–65535. */
    port: integer("port").notNull(),
    /**
     * Selected bridge network (actual engine name, never a Compose alias).
     * Null for published-port-only rootless services with no usable bridge.
     */
    networkName: text("network_name"),
    networkId: text("network_id"),
    /** Fingerprint of {hostname, port, network} — see `discoveryConfigHash`. */
    configHash: text("config_hash").notNull(),

    // ── Resolved upstream (persisted separately from authored config) ────
    /** network-ip (bridge direct IP) | published-port (observed host binding). */
    upstreamStrategy: text("upstream_strategy").$type<"network-ip" | "published-port" | null>(),
    /** Host port of the published binding, when the strategy is published-port. */
    hostPort: integer("host_port"),
    /** Host address of the published binding (loopback / all-interfaces), when known. */
    hostIp: text("host_ip"),

    // ── Observation (last successful inspect) ────────────────────────────
    /** Observed container id; changes on replacement, null once removal is confirmed. */
    containerId: text("container_id"),
    containerName: text("container_name"),
    /** Container IPv4 address on the selected network at last observation. */
    ipAddress: text("ip_address"),
    /**
     * Cached `State.Running` from the last successful observation. FILTERS the
     * certificate queue only — a fresh re-inspection still gates every ACME
     * order (docs: "a cached running flag alone is insufficient").
     */
    containerRunning: boolean("container_running").notNull().default(false),
    /** observed | missing (confirmed gone) | error (inspection failed; state kept) | invalid (present but declaration rejected; observation invalidated) */
    observationStatus: text("observation_status").$type<"observed" | "missing" | "error" | "invalid">().notNull().default("observed"),
    lastObservedAt: timestamp("last_observed_at"),

    // ── Edge apply state (independent of observation) ────────────────────
    /**
     * Route/config application to the server's Edge: pending (desired changed),
     * applied (route confirmed written), error (last apply failed; retry with
     * backoff), blocked (identity/hostname conflict — NEVER retried; the
     * operator must resolve the conflict, so retrying would either pick a
     * replica arbitrarily or fight another owner's route). Success is NEVER
     * assumed from the DB write alone — `applied` means the reconciler verified
     * the write through the shared primitives.
     */
    applyState: text("apply_state").$type<"pending" | "applied" | "error" | "blocked">().notNull().default("pending"),
    /** Bumped on every config change; `appliedGeneration` catching up proves convergence. */
    desiredGeneration: integer("desired_generation").notNull().default(0),
    appliedGeneration: integer("applied_generation").notNull().default(0),
    applyError: text("apply_error"),
    applyAttempts: integer("apply_attempts").notNull().default(0),
    nextApplyAt: timestamp("next_apply_at"),
    /**
     * A confirmed route exists that must be RETIRED (container removed or its
     * declaration invalidated). Retirement is scheduled INDEPENDENTLY of
     * blocking: `blocked` stops forward applies (conflict — never create or
     * update routes), but a route applied before the block is real and its
     * upstream must still go away on removal. The reconciler consumes this via
     * `dueForWithdrawal()` and clears it with `markWithdrawn()`; blocked/
     * suppressed state stays untouched so forward-apply policy is unchanged.
     */
    withdrawalPending: boolean("withdrawal_pending").notNull().default(false),

    // ── Operator intent ──────────────────────────────────────────────────
    /**
     * Forget/suppress marker: the operator declined this declaration. The
     * scanner keeps observing (status shows it) but never reconciles routes
     * for it until re-accepted. Distinct from disable, which pauses the
     * server; absence of a deployment never implies this.
     */
    suppressed: boolean("suppressed").notNull().default(false),
    suppressedAt: timestamp("suppressed_at"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_discovery_binding_identity").on(t.serverId, t.serviceKey),
    // Status UI lists a server's services; the reconciler sweeps by apply state.
    index("idx_discovery_binding_server").on(t.serverId),
    index("idx_discovery_binding_apply").on(t.serverId, t.applyState),
    // The certificate sweep matches server-owned domains to live bindings.
    index("idx_discovery_binding_hostname").on(t.serverId, t.hostname),
  ],
);

/**
 * Server-scoped discovery rows reference `servers` directly, and their domain
 * rows live in `domain` with `ownerType = "server"` + `domain.serverId`.
 * The binding↔domain link is (serverId, hostname) — no FK on purpose: forgetting
 * a binding must be able to RETAIN the domain row (certificate material, expiry,
 * retry state survive; docs "retain ownership/certificate metadata"), which a
 * cascade could not do. The certificate sweep joins on hostname + server.
 */
