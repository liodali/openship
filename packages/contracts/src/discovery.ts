import { Type, type Static } from "@sinclair/typebox";
import { DISCOVERY_TLS_ORIGIN_CA_VALIDITY, DISCOVERY_TLS_PROVIDERS, DISCOVERY_TLS_DEFAULT_PROVIDER } from "@repo/core";

const nullableString = Type.Union([Type.String(), Type.Null()]);

// ── Managed TLS providers (docs/cloudflare-origin-ca-discovery-plan.md) ─────

/** The ONLY two managed provider IDs — mirrored from @repo/core's vocabulary. */
export const DiscoveryTlsProviderSchema = Type.Union(
  DISCOVERY_TLS_PROVIDERS.map((p) => Type.Literal(p)),
);
export type DiscoveryTlsProvider = Static<typeof DiscoveryTlsProviderSchema>;

/**
 * Server discovery TLS settings: the default provider applied to NEWLY
 * enrolled domains. Changing it never switches existing certificates (each
 * domain persists its own resolved provider); no Cloudflare credential or
 * zone is stored at server scope.
 */
export const DiscoveryTlsSettingsSchema = Type.Object({
  defaultProvider: DiscoveryTlsProviderSchema,
});
export type DiscoveryTlsSettings = Static<typeof DiscoveryTlsSettingsSchema>;

/** PUT body for the server default (accepted values: the two provider IDs only). */
export const DiscoveryTlsSettingsInputSchema = Type.Object(
  { defaultProvider: DiscoveryTlsProviderSchema },
  { additionalProperties: false },
);
export type DiscoveryTlsSettingsInput = Static<typeof DiscoveryTlsSettingsInputSchema>;

/** Per-domain Cloudflare Origin CA configuration — required as a block. */
export const DiscoveryDomainTlsCloudflareSchema = Type.Object(
  {
    /** An existing encrypted organization credential (never a token). */
    credentialId: Type.String({ minLength: 1 }),
    /** The exact authorized Cloudflare zone id. */
    zoneId: Type.String({ minLength: 1 }),
    /** Zone display name; recorded only once verified through Cloudflare. */
    zoneName: Type.Optional(Type.String({ minLength: 1 })),
    validityDays: Type.Optional(
      Type.Integer({
        minimum: DISCOVERY_TLS_ORIGIN_CA_VALIDITY.minDays,
        maximum: DISCOVERY_TLS_ORIGIN_CA_VALIDITY.maxDays,
        description: `Origin CA validity in days (default ${DISCOVERY_TLS_ORIGIN_CA_VALIDITY.defaultDays})`,
      }),
    ),
  },
  { additionalProperties: false },
);

/**
 * STRICT discriminated per-domain policy: Let's Encrypt rejects Cloudflare-only
 * fields; Cloudflare requires its credential and zone. Invalid provider IDs are
 * validation errors, never a fallback.
 */
export const DiscoveryDomainTlsPolicyInputSchema = Type.Union([
  Type.Object({ provider: Type.Literal("letsencrypt") }, { additionalProperties: false }),
  Type.Object(
    { provider: Type.Literal("cloudflare-origin-ca"), cloudflare: DiscoveryDomainTlsCloudflareSchema },
    { additionalProperties: false },
  ),
]);
export type DiscoveryDomainTlsPolicyInput = Static<typeof DiscoveryDomainTlsPolicyInputSchema>;

/** How a domain's persisted provider was chosen. */
export const DiscoveryTlsProviderSourceSchema = Type.Union([
  Type.Literal("default"),
  Type.Literal("explicit"),
]);
export type DiscoveryTlsProviderSource = Static<typeof DiscoveryTlsProviderSourceSchema>;

/** The initial server default, as a schema (for tests and generated clients). */
export const DISCOVERY_TLS_DEFAULT_PROVIDER_SCHEMA = Type.Literal(DISCOVERY_TLS_DEFAULT_PROVIDER);

/** Enable/disable server discovery. */
export const DiscoveryConfigureInputSchema = Type.Object(
  {
    enabled: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type DiscoveryConfigureInput = Static<typeof DiscoveryConfigureInputSchema>;

/** Operator intent on one discovered service. */
export const DiscoveryServiceActionInputSchema = Type.Object(
  {
    serviceKey: Type.String({ minLength: 1, description: 'Stable discovery identity, e.g. "id:my-app"' }),
  },
  { additionalProperties: false },
);
export type DiscoveryServiceActionInput = Static<typeof DiscoveryServiceActionInputSchema>;

export const DiscoverySettingsSchema = Type.Object({
  serverId: Type.String(),
  enabled: Type.Boolean(),
  workspaceId: nullableString,
  sweepIntervalSeconds: Type.Number(),
  lastScanAt: nullableString,
  lastScanError: nullableString,
});
export type DiscoverySettings = Static<typeof DiscoverySettingsSchema>;

/** Route/TLS state for one discovered service (binding + its server-scoped domain). */
export const DiscoveryServiceSchema = Type.Object({
  id: Type.String(),
  serviceKey: Type.String(),
  composeProject: nullableString,
  composeService: nullableString,
  hostname: Type.String(),
  port: Type.Number(),
  networkName: nullableString,
  /** observed | missing | error | invalid */
  observationStatus: Type.String(),
  containerName: nullableString,
  containerRunning: Type.Boolean(),
  /** network-ip | published-port | null (not resolved yet) */
  upstreamStrategy: nullableString,
  ipAddress: nullableString,
  hostPort: nullableString,
  /** pending | applied | error | blocked */
  applyState: Type.String(),
  applyError: nullableString,
  applyAttempts: Type.Number(),
  nextApplyAt: nullableString,
  /** A confirmed route exists that must be retired (backend removed/invalidated). */
  withdrawalPending: Type.Boolean(),
  suppressed: Type.Boolean(),
  /** desired vs applied generation: a gap means reconciliation is in flight. */
  desiredGeneration: Type.Number(),
  appliedGeneration: Type.Number(),
  updatedAt: nullableString,
  /** The server-scoped domain backing the TLS lifecycle (missing until first apply). */
  tls: Type.Union([
    Type.Object({
      hostname: Type.String(),
      verified: Type.Boolean(),
      /** none | pending | issued | error ... — the domain row's own ssl state. */
      sslStatus: Type.String(),
      sslExpiresAt: nullableString,
      sslIssuer: nullableString,
    }),
    Type.Null(),
  ]),
});
export type DiscoveryService = Static<typeof DiscoveryServiceSchema>;

export const DiscoveryStatusSchema = Type.Object({
  settings: DiscoverySettingsSchema,
  services: Type.Array(DiscoveryServiceSchema),
});
export type DiscoveryStatus = Static<typeof DiscoveryStatusSchema>;

/** Result of one full (fresh) sweep of one server. */
export const DiscoveryRescanSchema = Type.Object({
  serverId: Type.String(),
  failed: Type.Array(Type.String()),
  scan: Type.Union([Type.Object({ scanned: Type.Number(), ok: Type.Boolean() }), Type.Null()]),
  reconcile: Type.Union([
    Type.Object({
      applied: Type.Array(Type.String()),
      removed: Type.Array(Type.String()),
      retained: Type.Array(Type.String()),
      withdrawals: Type.Array(Type.String()),
      failed: Type.Array(Type.Object({ serviceKey: Type.String(), reason: Type.String() })),
      ok: Type.Boolean(),
    }),
    Type.Null(),
  ]),
  repair: Type.Union([
    Type.Object({
      scanned: Type.Number(),
      repaired: Type.Array(Type.String()),
      retained: Type.Array(Type.String()),
      requeued: Type.Array(Type.String()),
      failed: Type.Array(Type.Object({ serviceKey: Type.String(), reason: Type.String() })),
    }),
    Type.Null(),
  ]),
});
export type DiscoveryRescan = Static<typeof DiscoveryRescanSchema>;
