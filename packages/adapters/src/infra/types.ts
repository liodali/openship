/**
 * Infrastructure provider interfaces - routing and SSL.
 *
 * Routing and SSL are separate from the runtime because:
 *   - Docker is a runtime, not a reverse proxy. Nginx handles routing.
 *   - SSL is managed by certbot/ACME, not by Docker.
 *   - Cloud routing uses a completely different mechanism (API calls).
 *   - Desktop/dev doesn't need routing or SSL at all.
 *
 * Implementations:
 *   - NginxProvider    → Nginx server blocks + certbot (self-hosted)
 *   - CloudInfra       → Oblien API (cloud)
 *   - NoopInfra        → No-op (desktop/dev)
 */

import type { ManualCert, RouteConfig, SslResult } from "../types";
import type { OutputProbeResult, StaticProbeOptions } from "../system/output-exists";
import type { RouteProtection } from "./route-protection";
import type { TcpProbeResult } from "../system/reachability";

// ─── Routing ─────────────────────────────────────────────────────────────────

export type ProjectRouteCleanupResult = "removed" | "absent" | "foreign";

/**
 * What a managed vhost's CONFIGURATION FILE selects for TLS — the emitted
 * `ssl_certificate` line, classified against the caller's expected certificate
 * source (the exact hostname's directory, or a shared wildcard pattern's).
 *
 * This is a CONFIG-FILE inspection, deliberately not a live-listener probe:
 * it proves which pair the managed vhost is written to serve, never that a
 * running listener actually serves it. Callers must word their outcomes
 * accordingly ("configured selection"), and pair it with a material read
 * (fingerprint) when they need proof about the bytes themselves.
 *
 *   "expected"        — the vhost selects certDir/<expectedCertDomain>/fullchain.pem.
 *   "other"          — the vhost selects a DIFFERENT source: the enrollment
 *                      bootstrap pair, another exact/wildcard directory, or an
 *                      operator-rewritten path. Confirmed drift.
 *   "no_tls_listener" — the managed vhost has no ssl_certificate at all (an
 *                      HTTP-only conf); for a hostname whose TLS is ours this
 *                      is also drift, but of a different shape.
 */
export type VhostCertSelection =
  | { selection: "expected"; certPath: string }
  | { selection: "other"; certPath: string }
  | { selection: "no_tls_listener" };

export interface RoutingProvider {
  /** Dial from the proxy's own network namespace, never the control plane's. */
  probeUpstream?(host: string, port: number): Promise<TcpProbeResult>;
  setRouteEdgePages?(domain: string, pages: import("@repo/core").CompiledEdgePages | null): Promise<boolean>;
  getRouteEdgePages?(domain: string): Promise<import("@repo/core").CompiledEdgePages | null | undefined>;
  /** Full loopback upstream inventory from this edge's own connection.
   * Unreadable or ambiguous configuration must reject, never return an empty set. */
  listLoopbackUpstreamPortsStrict?(opts?: { refresh?: boolean }): Promise<Set<number>>;
  /** Validated atomic update of an already-published hostname; false means no route yet. */
  setRouteProtection?(
    domain: string,
    policy: RouteProtection | null,
  ): Promise<boolean>;
  /** Register a reverse-proxy route (domain → container/process) */
  registerRoute(route: RouteConfig): Promise<void>;

  /** Remove a reverse-proxy route. Providers that can roll back a failed
   * removal must not recreate it after the caller has abandoned the attempt. */
  removeRoute(domain: string, opts?: { signal?: AbortSignal }): Promise<void>;

  /** Does this hostname have a generated vhost on this provider's edge right now?
   * The repair sweeps' existence probe: a DELETED vhost has no sidecar left to
   * replay from, so only durable caller records know it should exist. Optional:
   * a provider without on-edge generated config (cloud API, no-edge desktop)
   * has nothing to probe and nothing to repair — sweeps skip it. */
  hasRoute?(domain: string): Promise<boolean>;

  /** The persisted config state of a hostname's vhost (what registerRoute last
   * wrote), or null when there is no sidecar or it is unreadable. Repair uses
   * this to CLASSIFY an existing vhost (serving proxy vs retained 503) instead
   * of assuming file existence means correctness. Optional: same scope as
   * hasRoute. */
  readRouteState?(domain: string): Promise<RouteConfig | null>;

  /**
   * The generation marker stamped in a hostname's generated vhost conf — what
   * `registerRoute` writes so a fix to the EMITTED config shape can reach boxes
   * that are not redeploying (see `VHOST_GENERATION`/`reapplyStoredRoutes`).
   * Null means the conf exists but carries no marker: older than the marker
   * itself, therefore stale — the same rule the box-wide replay applies. THROWS
   * when the conf cannot be read (transport failure, or it vanished mid-sweep):
   * a caller deciding an in-place rewrite must treat "unknown" as "leave
   * alone", never guess — and must not confuse "unstamped" with "missing", or
   * a route removed between `hasRoute` and this read would be resurrected.
   *
   * Optional: only a provider that keeps generated config on disk can answer —
   * same scope as hasRoute/readRouteState.
   */
  readVhostGeneration?(domain: string): Promise<number | null>;

  /**
   * The certificate source the domain's MANAGED vhost currently selects, read
   * from the emitted conf's `ssl_certificate` directive — the drift signal the
   * TLS lifecycle needs beside {@link readVhostGeneration}.
   *
   * Healthy certificate FILES prove nothing about route activation: the read
   * that reuses material resolves through the certificate directory, so a
   * vhost still serving its enrollment bootstrap pair (or a certificate the
   * policy has since replaced) reads as healthy while visitors get the wrong
   * certificate. This read compares what the conf NAMES against the source the
   * caller expects (the exact hostname, or the declared shared wildcard
   * pattern) — see {@link VhostCertSelection} for the honesty contract: it
   * proves the CONFIGURED selection, never what a running listener serves.
   *
   * Answers, all distinguishable:
   *   - a {@link VhostCertSelection} — the conf exists and was classified;
   *   - `null` — NO managed vhost exists for the hostname. Not drift: a
   *     missing route is the route repair sweep's own state, and an
   *     activation here would be a silent no-op (activation re-registers
   *     from the sidecar; no sidecar means nothing to re-register).
   *   - THROWS when the conf exists but cannot be read (transport, vanished
   *     mid-sweep). "Unproven" is not drift and not health — callers treat a
   *     throw exactly like their other unprovable reads: queue durable work
   *     for the ensure API, wait for the next pass for periodic audits.
   *
   * Optional: only a provider that keeps generated config on disk can answer —
   * same scope as hasRoute/readRouteState/readVhostGeneration.
   */
  readVhostCertSelection?(
    domain: string,
    opts: { expectedCertDomain: string },
  ): Promise<VhostCertSelection | null>;

  /** Project-scoped teardown may preserve a route freshly proven to belong to
   * another project. Unknown ownership must reject. A foreign result also forbids
   * a later generic release of the managed hostname. */
  removeProjectRoute?(domain: string): Promise<ProjectRouteCleanupResult>;

  /** Pause a file-served site while retaining its hostname and certificate. */
  suspendRoute?(domain: string): Promise<void>;

  /**
   * Re-emit vhosts an older generator wrote, so a fix to the EMITTED config shape reaches
   * a box that isn't redeploying. Converged boxes do nothing; see
   * `NginxProvider.reapplyStoredRoutes`.
   *
   * Optional: only a provider that keeps generated config on disk has anything to replay.
   * Cloud routes through Oblien's API and desktop has no edge at all.
   */
  reapplyStoredRoutes?(): Promise<{
    scanned: number;
    repaired: string[];
    failed: { slug: string; reason: string }[];
  }>;

  /**
   * Does a static `root` actually resolve WHERE THE PROXY LOOKS?
   *
   * Optional: only a provider that serves files from a path answers. The point is
   * the vantage point, not the check — for a containerized edge the vhost `root`
   * is a HOST path that must be bind-mounted into the container, so probing the
   * host FS reports the files present while nginx sees an empty directory and
   * 404s. Only the provider knows which executor sees what nginx sees, so the
   * probe belongs here rather than in a caller guessing at edge topology.
   *
   * `opts.hostname` opts into the HTTP half — one real request through the edge
   * for that host and path. Same vantage-point argument, taken one step further:
   * the filesystem check proves the bytes are reachable, an actual request proves
   * they are SERVED (readable modes, a vhost that exists, a root the container can
   * see). Omit it and the probe stays filesystem-only.
   *
   * Advisory: implementations never throw — `checked:false` means "no signal", and
   * an absent `served` likewise.
   */
  probeStaticRoot?(servedPath: string, opts?: StaticProbeOptions): Promise<OutputProbeResult>;

  /**
   * Serve edge-target challenge tokens for `host`, so Openship Cloud's shared edge
   * can prove this box controls a routing target it is asked to forward to.
   *
   * Optional for the same reason `probeStaticRoot` is: only a provider that owns an
   * HTTP surface on this box can answer, and "this provider has no
   * `serveEdgeChallenge`" is a clean, reportable reason rather than a silent no-op.
   * Cloud routes through Oblien's own edge and has nothing to serve from.
   *
   * Call with `{ host }` alone at edge-ensure to make the box ABLE to answer before
   * any challenge exists (the location serves a directory, so it is valid empty), and
   * with `{ host, tokens }` from the verify flow to serve the issued tokens.
   *
   * `tokens` is a LIST because a re-issued verification resets the token while an
   * older record may still be probed, and because two orgs can target one box. Every
   * token given is served, and none is ever removed — Oblien re-probes the same token
   * near its 90-day expiry, so dropping one silently breaks that route months later.
   */
  serveEdgeChallenge?(input: { host: string; tokens?: readonly string[] }): Promise<{
    served: boolean;
    /** How it is answered — an existing vhost for the host, or our own single-purpose one. */
    via: "existing-vhost" | "challenge-vhost" | null;
    /** Set when an unmanaged//stale vhost already claims the host; names the file. */
    claimedBy?: string;
    reason?: string;
  }>;
}

// ─── SSL ─────────────────────────────────────────────────────────────────────

export interface ProvisionCertOptions {
  onLog?: (line: string) => void;
  force?: boolean;
  challenge?: "http-01" | "dns-01";
  /** Existing hook commands already present in the Certbot execution environment. */
  dnsAuthHook?: string;
  dnsCleanupHook?: string;
  /** Hook bodies that the provider must materialize beside Certbot on its target. */
  dnsAuthHookScript?: string;
  dnsCleanupHookScript?: string;
}

export interface SslProvider {
  /** The provider handles issuance and renewal through its own API. DNS
   * credentials and local Certbot hook scripts must not be required or sent. */
  readonly certificateManagement?: "provider";
  /** Resumable DNS-01 orders. Waiting for a person must not hold an executor,
   * Certbot process, or deployment lock. Returned order material is private. */
  dnsChallengeProvider?(): Promise<DnsCertificateProvider>;
  /** Enable the current route with an already-validated certificate, without
   * opening another ACME order. A readable PEM alone does not prove a failed
   * vhost reload has recovered. Only providers that own the route implement it. */
  activateCert?(domain: string): Promise<void>;
  /** Provision a new TLS certificate for a domain. `onLog`, when given, streams
   *  certbot's output line-by-line (powers the live-log verify modal). `force`
   *  bypasses the "cert already on disk" short-circuit and passes certbot
   *  `--force-renewal`, so a present-but-stale/near-expiry cert is actually
   *  reissued instead of returned as-is. */
  provisionCert(domain: string, opts?: ProvisionCertOptions): Promise<SslResult>;

  /** Renew an existing TLS certificate */
  renewCert(domain: string, opts?: ProvisionCertOptions): Promise<SslResult>;

  /**
   * Install an operator-supplied certificate (bring-your-own / Cloudflare
   * Origin CA) for a domain — no ACME. Writes the cert + key to the same
   * on-disk location certbot would use, then re-registers the vhost with TLS.
   * Powers origin TLS behind an upstream proxy (Cloudflare Full-strict) and
   * plain BYO certs on direct domains.
   */
  installCert(domain: string, cert: ManualCert): Promise<SslResult>;

  /**
   * Complete the renewal-ownership takeover of a previously staged manual
   * install: remove the ACME renewal record the installer was about to
   * remove. Powers crash recovery — a crash between staging a manual pair
   * and this removal otherwise leaves Certbot able to REPLACE the manual
   * certificate on its next run, silently discarding the installed material.
   * Idempotent; providers whose installs never touch an ACME renewer may
   * omit it.
   */
  takeoverRenewalOwnership?(domain: string): Promise<void>;

  /**
   * Install a SHARED wildcard certificate under its pattern directory
   * (certDir/"*.base" — the pattern, never a concrete child). Children
   * resolve it through the parent-wildcard lookup; there is NO vhost of its
   * own to activate and no ACME renewal record to remove. Powers shared
   * wildcard certificates, which are authorized through a requesting child
   * (wildcard patterns have no domain row of their own).
   */
  installSharedWildcardCert?(
    wildcard: string,
    cert: ManualCert,
    opts?: {
      children?: string[];
      /** Replace a CERTBOT-MANAGED exact certificate that shadows the
       *  pattern, transferring renewal ownership (removing its renewal
       *  record). Destructive to independently-managed state — only for an
       *  explicitly authorized provider switch. */
      replaceCertbot?: boolean;
    },
  ): Promise<SslResult>;

  /**
   * Read-only verification: report whether a valid cert is currently present
   * for the domain (and its expiry/issuer) WITHOUT running certbot. Powers the
   * "Recheck SSL" action and lets a redeploy confirm an existing cert instead
   * of mistaking a transient read failure for "no cert".
   */
  verifyCert(domain: string): Promise<SslResult>;
}

export interface DnsCertificateProvider {
  readonly directoryUrl: string;
  createAccountKey(): Promise<string>;
  prepare(hostname: string, accountKey: string): Promise<{
    record: { name: string; value: string };
    expiresAt: string;
    /** Opaque serialized order, CSR and key. Encrypt at rest; never return to a client. */
    state: string;
  }>;
  complete(hostname: string, accountKey: string, state: string): Promise<ManualCert>;
}
