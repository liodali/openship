"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  DISCOVERY_TLS_ORIGIN_CA_DEFAULT_VALIDITY_DAYS,
  DISCOVERY_TLS_ORIGIN_CA_VALIDITY_DAYS,
} from "@repo/core";
import type { DiscoveryDomainTlsPolicyInput } from "@repo/contracts";
import { Icon as UiIcon } from "@repo/ui/icons";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { Drawer } from "@/components/ui/Drawer";
import { DisclosureSummary } from "@/components/ui/DisclosureSummary";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { CredentialForm } from "@/components/credentials/CredentialForm";
import { credentialsApi, type Credential } from "@/lib/api/credentials";
import { discoveryApi, type DiscoveryService } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api/client";
import { isPermissionError } from "@/hooks/useServerDiscovery";
import { useScopedResource } from "@/hooks/use-scoped-resource";

/**
 * Per-service managed TLS configuration (docs/cloudflare-origin-ca-discovery-plan.md §5).
 *
 * ONE drawer behind every service's "Configure TLS" menu action, for the server
 * page's card and the dedicated /discovery page. It is deliberately two
 * separate operations with separate permissions, never one "apply everything":
 *
 *  - SAVE (server:admin) persists the per-domain policy — provider, and for
 *    Cloudflare the saved credential/zone/validity. Saving is NEVER presented
 *    as certificate installation: it stores intent only, and the copy says so.
 *  - ENSURE / RETRY (server:write) queues the durable certificate work
 *    explicitly (idempotent; the backend decides skip/queue/defer).
 *
 * Read-only users see the same state (the policy GET is server:read); failed
 * mutations surface inline with the input retained, permission failures get
 * their own copy. Frontend visibility is not the enforcement — the backend
 * owns every decision; this drawer only renders state and issues intent.
 *
 * The declared wildcard source and the service's addressing (container port,
 * published host port, network) are READ-ONLY: they are container-declaration
 * facts (openship.* labels / OPENSHIP_* env) that need their own persistence
 * and reconciliation path, which this change deliberately does not add.
 */

/** Provider ids as select values — the contract's only two managed selections. */
type ProviderChoice = "letsencrypt" | "cloudflare-origin-ca";

/** Mutation state for one drawer action: busy, inline error, permission flag. */
function useDrawerMutation() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const active = useRef(true);
  const pending = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const execute = async <T,>(operation: () => Promise<T>): Promise<T | null> => {
    if (pending.current) return null; // duplicate submissions are impossible
    pending.current = true;
    setBusy(true);
    setError(null);
    setPermissionDenied(false);
    try {
      const result = await operation();
      return active.current ? result : null;
    } catch (cause) {
      if (active.current) {
        const permission = isPermissionError(cause);
        setPermissionDenied(permission);
        if (!permission) setError(getApiErrorMessage(cause));
      }
      return null;
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  };
  /** Local validation lands in the same inline slot as a server rejection. */
  const fail = useCallback((message: string) => {
    setError(message);
    setPermissionDenied(false);
  }, []);
  const clearError = useCallback(() => {
    setError(null);
    setPermissionDenied(false);
  }, []);
  return { busy, error, permissionDenied, execute, fail, clearError };
}

export function ServiceTlsDrawer({
  serverId,
  service,
  onClose,
  onChanged,
}: {
  serverId: string;
  /** The card's CURRENT row snapshot — identity plus the read-only display state. */
  service: DiscoveryService;
  /** Close request from the opener or the drawer's own controls. */
  onClose(): void;
  /** The card refreshes its status after a mutation so row/TLS state follows. */
  onChanged(): void;
}) {
  const { t, locale } = useI18n();
  const copy = t.servers.discovery.tlsDrawer;
  const id = useId();

  // The domain's persisted policy (desired/installed provider, provenance,
  // Cloudflare references) — reloaded after every mutation, and POLLED while
  // certificate work is in flight: a queued operation can complete while the
  // drawer sits open, and the installed-provider/transition readouts must
  // follow the worker's outcome without a user action. The interval is
  // key-stable per work-state so the resource's effect only re-arms on a
  // transition, never per render.
  const activeOperation =
    service.tlsOperation && service.tlsOperation.state !== "complete" ? service.tlsOperation : null;
  const tlsWorkActive = !!activeOperation || service.tls?.sslStatus === "provisioning";
  const policyInterval = useCallback(() => (tlsWorkActive ? 5_000 : 0), [tlsWorkActive]);
  const policyRes = useScopedResource(
    useCallback(
      () => discoveryApi.serviceTls(serverId, service.serviceKey),
      [serverId, service.serviceKey],
    ),
    policyInterval,
  );
  // Saved Cloudflare credentials (names + status only — secrets never leave
  // the credentials flow) and the provider schema for the inline add form.
  const held = useScopedResource(
    useCallback(async () => {
      const [providers, credentials] = await Promise.all([
        credentialsApi.providers(),
        credentialsApi.list(),
      ]);
      return {
        cloudflare: providers.data.find((p) => p.id === "cloudflare") ?? null,
        credentials: credentials.data.filter((c: Credential) => c.provider === "cloudflare"),
      };
    }, []),
  );

  const [provider, setProvider] = useState<ProviderChoice>("letsencrypt");
  const [credentialId, setCredentialId] = useState("");
  const [zoneId, setZoneId] = useState("");
  /** "default" (send nothing) or one of the contract's discrete durations. */
  const [validity, setValidity] = useState<string>("default");
  const [addingCredential, setAddingCredential] = useState(false);
  const [credentialBusy, setCredentialBusy] = useState(false);
  /** Success notes are separate from errors: save ≠ install, ensure ≠ done. */
  const [savedNote, setSavedNote] = useState(false);
  const [ensureNote, setEnsureNote] = useState<string | null>(null);

  const saveMutation = useDrawerMutation();
  const ensureMutation = useDrawerMutation();

  /**
   * True once the operator has touched a form field since the last seed or
   * save. Background policy reads (the in-flight-work poll above) must
   * PRESERVE those unsaved edits — only a successful save, which persists the
   * draft, may re-seed the form from server truth.
   */
  const userEdited = useRef(false);

  // Seed the form from the persisted policy each time it (re)loads, EXCEPT
  // while the operator holds unsaved edits: the resource refetches after a
  // mutation, a scope change, and the work-completion poll, and none of those
  // may clobber a draft the user is still editing. A FAILED save never
  // refetches at all, so its draft survives by construction.
  useEffect(() => {
    const policy = policyRes.data;
    if (!policy || userEdited.current) return;
    setProvider(policy.provider);
    setCredentialId(policy.cloudflare?.credentialId ?? "");
    setZoneId(policy.cloudflare?.zoneId ?? "");
    setValidity(
      policy.cloudflare?.validityDays != null ? String(policy.cloudflare.validityDays) : "default",
    );
  }, [policyRes.data]);

  /**
   * The card's row is the CHEAP background signal: an issuance can finish
   * entirely between card polls, so no work-active window may exist for the
   * poll above to catch — the card then shows the NEW installed provider
   * while the loaded policy still reflects the old one (stale "Moving to…").
   *
   * Two staleness directions are handled differently:
   *  - the ROW moved (the card learned a background outcome first): the
   *    loaded policy is behind → re-read it once;
   *  - the POLICY moved (this drawer's own ensure/save refresh, or a heal
   *    landing): the display already holds the newer read → nothing to do;
   *    the row converges or signals its own transition later.
   *
   * A transition observed while the policy is still LOADING is RETAINED, not
   * consumed: the first response can be OLDER than the row, so the comparison
   * must run against the row's CURRENT state once loading completes —
   * otherwise the stale response lands unchallenged and the transition is
   * lost forever ("Moving to…" sticks).
   *
   * Bounded: one heal per row state (cleared on convergence, so a later row
   * move — including a revert — can heal again), no loop when row and policy
   * persistently disagree, and no read at all for a convergent row (e.g. the
   * drawer's own save, whose mutation already refreshed the policy). Unsaved
   * edits survive every re-read via the seeding guard above.
   */
  const lastRowProviderPair = useRef<string | null>(null);
  /** A row transition observed while the policy was loading, awaiting comparison. */
  const retainedRowTransition = useRef<string | null>(null);
  /** The row state a heal was already requested for (bounded retry + revert support). */
  const healRequestedForRow = useRef<string | null>(null);
  useEffect(() => {
    // An unenrolled service has no installed provider to track; its policy is
    // the resolved server default, and there is nothing to converge.
    if (!service.tls) return;
    const rowPair = `${service.tls.tlsProvider ?? ""}|${service.tls.tlsActiveProvider ?? ""}`;
    const loadedPair = policyRes.data
      ? `${policyRes.data.provider}|${policyRes.data.activeProvider ?? ""}`
      : null;
    const rowMoved =
      lastRowProviderPair.current !== null && lastRowProviderPair.current !== rowPair;
    lastRowProviderPair.current = rowPair;

    if (loadedPair === null) {
      // The first read is still in flight: nothing to compare against yet.
      // RETAIN the transition — never advance past it silently.
      if (rowMoved) retainedRowTransition.current = rowPair;
      return;
    }
    if (loadedPair === rowPair) {
      // Converged: a later row move — including a revert — may heal again.
      healRequestedForRow.current = null;
      return;
    }
    // The loaded policy disagrees with the row. Heal only if the ROW moved
    // (live transition and/or one retained from the loading window): a
    // policy-side move is the drawer already holding newer truth.
    const pending = retainedRowTransition.current;
    retainedRowTransition.current = null;
    const rowChanged = rowMoved || pending !== null;
    if (!rowChanged) return;
    if (healRequestedForRow.current === rowPair) return;
    healRequestedForRow.current = rowPair;
    policyRes.refresh();
  }, [service, policyRes.data, policyRes.refresh]);

  const busy = saveMutation.busy || ensureMutation.busy || credentialBusy;
  const requestClose = useCallback(() => {
    // Guard backdrop, Escape and the close button while a write is in flight —
    // a mid-request dismissal would leave the operator without the outcome.
    if (!busy) onClose();
  }, [busy, onClose]);

  const policy = policyRes.data;

  // The Cloudflare credential list must cover a policy referencing a credential
  // that no longer exists (deleted/rotated) — the raw id is an identifier, not
  // a secret, and hiding it would render the saved state unreviewable.
  const credentials = held.data?.credentials ?? [];
  const credentialOptions = credentials.some((c) => c.id === credentialId)
    ? credentials
    : credentialId
      ? [{ id: credentialId, name: credentialId, status: "active" } as Credential, ...credentials]
      : credentials;

  async function saveConfiguration() {
    setSavedNote(false);
    setEnsureNote(null);
    const input: DiscoveryDomainTlsPolicyInput =
      provider === "letsencrypt"
        ? { provider: "letsencrypt" }
        : {
            provider: "cloudflare-origin-ca",
            cloudflare: {
              credentialId,
              zoneId: zoneId.trim(),
              ...(validity !== "default"
                ? {
                    validityDays: Number(
                      validity,
                    ) as (typeof DISCOVERY_TLS_ORIGIN_CA_VALIDITY_DAYS)[number],
                  }
                : {}),
            },
          };
    if (provider === "cloudflare-origin-ca") {
      if (!credentialId) {
        saveMutation.fail(copy.credentialRequired);
        return;
      }
      if (!zoneId.trim()) {
        saveMutation.fail(copy.zoneRequired);
        return;
      }
    }
    const saved = await saveMutation.execute(() =>
      discoveryApi.configureServiceTls(serverId, service.serviceKey, input),
    );
    if (!saved) return; // inline error retained; the draft is untouched
    // The draft just became server truth: re-arm seeding so the refreshed
    // policy lands in the form (identical values for a plain re-save).
    userEdited.current = false;
    setSavedNote(true);
    policyRes.refresh();
    onChanged();
  }

  async function ensureCertificate() {
    setSavedNote(false);
    setEnsureNote(null);
    const outcome = await ensureMutation.execute(() =>
      discoveryApi.ensureTls(serverId, service.serviceKey),
    );
    if (!outcome) return;
    setEnsureNote(
      outcome.outcome === "skipped"
        ? copy.ensureSkipped
        : outcome.outcome === "queued"
          ? copy.ensureQueued
          : outcome.outcome === "already_queued"
            ? copy.ensureAlreadyQueued
            : interpolate(copy.ensureDeferred, { reason: outcome.reason }),
    );
    policyRes.refresh();
    onChanged();
  }

  /** Durable operation state in the drawer's own wording (the chip title
   *  vocabulary stays on the card; here the state leads the line). `activeOperation`
   *  itself is computed beside the policy resource — the work-in-flight poll
   *  keys on it. */
  const operationStateLabel = (
    state: DiscoveryService["tlsOperation"] extends infer T
      ? T extends { state: infer S }
        ? S
        : never
      : never,
  ): string => {
    const tls = t.servers.discovery.tlsState;
    switch (state) {
      case "waiting":
        return tls.opQueued;
      case "running":
        return tls.opRunning;
      case "error":
        return tls.opError;
      case "deferred":
        return tls.opDeferred;
      default:
        return "";
    }
  };
  const providerLabel = (value: "letsencrypt" | "cloudflare-origin-ca") =>
    value === "cloudflare-origin-ca"
      ? t.servers.discovery.tlsState.providerCloudflareOriginCa
      : t.servers.discovery.tlsState.providerLetsencrypt;
  /** A transition names the DESTINATION (the desired provider); the
   *  "Installed provider" row above already names what currently serves. */
  const transition =
    policy && policy.activeProvider != null && policy.activeProvider !== policy.provider
      ? providerLabel(policy.provider)
      : null;
  const wildcard = service.tlsDeclaredWildcard;
  const selectedCredential = credentials.find((c) => c.id === credentialId);

  const field = (key: string, label: string, child: React.ReactNode, hint?: string) => (
    <div className="space-y-1.5">
      <label htmlFor={`${id}-${key}`} className="block text-sm">
        {label}
      </label>
      {child}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );

  return (
    <Drawer
      isOpen
      onClose={requestClose}
      label={copy.title}
      closeLabel={copy.close}
      closeDisabled={busy}
      contentKey={service.serviceKey}
      width="640px"
    >
      <div className="flex h-full min-h-0 flex-col">
        <header className="px-5 pt-6 pb-4 pe-16 rtl:pe-5 rtl:ps-16">
          <h2 className="text-lg font-semibold">{copy.title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {interpolate(copy.subtitle, { hostname: service.hostname })}
          </p>
        </header>

        <div
          className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 pb-5"
          aria-busy={policyRes.loading}
        >
          {policyRes.error ? (
            <div role="alert" className="space-y-2 text-sm text-danger">
              <p>{copy.loadFailed}</p>
              <p className="break-words">{policyRes.error}</p>
              <Button variant="secondary" size="sm" onClick={policyRes.refresh}>
                <UiIcon name="refresh" />
                {copy.refresh}
              </Button>
            </div>
          ) : !policy ? (
            <div className="space-y-3" aria-label={copy.loading}>
              <div className="h-12 animate-pulse rounded-xl bg-muted" />
              <div className="h-12 animate-pulse rounded-xl bg-muted" />
              <div className="h-28 animate-pulse rounded-xl bg-muted" />
            </div>
          ) : addingCredential && held.data?.cloudflare ? (
            <CredentialForm
              provider={held.data.cloudflare}
              onBusyChange={setCredentialBusy}
              onCancel={() => setAddingCredential(false)}
              onSaved={(credential) => {
                setAddingCredential(false);
                held.refresh();
                // A freshly created credential is an unsaved selection: the
                // same edit-preservation rule applies to it.
                userEdited.current = true;
                setCredentialId(credential.id);
              }}
            />
          ) : (
            <>
              {/* Certificate source and provenance are DECLARED/RECORDED facts,
                  read-only by design: editing them requires container
                  redeployment or a persistence/reconciliation path this form
                  does not own. */}
              <section className="space-y-2 rounded-2xl bg-card p-4">
                <dl className="space-y-2 text-sm">
                  <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
                    <dt className="text-muted-foreground">{copy.wildcardSource}</dt>
                    <dd className="font-medium">
                      {wildcard
                        ? interpolate(copy.wildcardShared, { pattern: wildcard })
                        : copy.wildcardExact}
                    </dd>
                  </div>
                  <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
                    <dt className="text-muted-foreground">{copy.provenance}</dt>
                    <dd className="font-medium">
                      {policy.selectionSource === "explicit"
                        ? copy.provenanceExplicit
                        : copy.provenanceDefault}
                    </dd>
                  </div>
                  <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
                    <dt className="text-muted-foreground">{copy.activeProvider}</dt>
                    <dd className="font-medium">
                      {policy.activeProvider === "cloudflare-origin-ca"
                        ? t.servers.discovery.tlsState.providerCloudflareOriginCa
                        : policy.activeProvider === "letsencrypt"
                          ? t.servers.discovery.tlsState.providerLetsencrypt
                          : copy.notInstalled}
                    </dd>
                  </div>
                  {transition && (
                    <p className="text-xs text-muted-foreground">
                      {interpolate(copy.transition, { provider: transition })}
                    </p>
                  )}
                  {service.tlsPolicyConflict && (
                    <p className="text-xs text-warning">
                      {interpolate(copy.policyConflict, { detail: service.tlsPolicyConflict })}
                    </p>
                  )}
                  {wildcard && (
                    <p className="text-xs text-muted-foreground">{copy.wildcardReadOnly}</p>
                  )}
                </dl>
              </section>

              <form
                className="space-y-4 rounded-2xl bg-card p-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveConfiguration();
                }}
              >
                <div className="space-y-1.5">
                  <label htmlFor={`${id}-provider`} className="block text-sm">
                    {copy.providerLabel}
                  </label>
                  <CustomSelect
                    id={`${id}-provider`}
                    variant="filled"
                    triggerClassName="bg-muted/60 hover:bg-muted"
                    value={provider}
                    onChange={(value) => {
                      userEdited.current = true;
                      setProvider(value as ProviderChoice);
                      saveMutation.clearError();
                      setSavedNote(false);
                    }}
                    options={[
                      {
                        value: "letsencrypt",
                        label: t.servers.discovery.tlsState.providerLetsencrypt,
                      },
                      {
                        value: "cloudflare-origin-ca",
                        label: t.servers.discovery.tlsState.providerCloudflareOriginCa,
                      },
                    ]}
                    disabled={saveMutation.busy || ensureMutation.busy}
                  />
                </div>
                {provider === "cloudflare-origin-ca" && (
                  <>
                    {held.error ? (
                      <p role="alert" className="text-sm text-danger">
                        {held.error}
                      </p>
                    ) : (
                      field(
                        "credential",
                        copy.cloudflareCredential,
                        <CustomSelect
                          id={`${id}-credential`}
                          variant="filled"
                          triggerClassName="bg-muted/60 hover:bg-muted"
                          value={credentialId}
                          onChange={(value) => {
                            userEdited.current = true;
                            setCredentialId(value);
                            saveMutation.clearError();
                          }}
                          options={credentialOptions.map((c) => ({
                            value: c.id,
                            label: c.name,
                            description:
                              c.status === "invalid" ? copy.invalidCredential : undefined,
                          }))}
                          placeholder={copy.chooseCredential}
                          emptyMessage={copy.noCredentials}
                          footerAction={
                            held.data?.cloudflare
                              ? {
                                  label: copy.addCredential,
                                  onClick: () => setAddingCredential(true),
                                }
                              : undefined
                          }
                          disabled={saveMutation.busy || ensureMutation.busy}
                        />,
                        selectedCredential?.status === "invalid"
                          ? copy.invalidCredential
                          : undefined,
                      )
                    )}
                    {field(
                      "zone",
                      copy.zoneId,
                      <Input
                        id={`${id}-zone`}
                        variant="filled"
                        dir="ltr"
                        value={zoneId}
                        onChange={(event) => {
                          userEdited.current = true;
                          setZoneId(event.target.value.trim());
                          saveMutation.clearError();
                        }}
                        placeholder="b2f04038fb95e595498567547ffe748a"
                        autoComplete="off"
                        spellCheck={false}
                        disabled={saveMutation.busy || ensureMutation.busy}
                      />,
                      copy.zoneIdHint,
                    )}
                    {field(
                      "validity",
                      copy.validity,
                      <CustomSelect
                        id={`${id}-validity`}
                        variant="filled"
                        triggerClassName="bg-muted/60 hover:bg-muted"
                        value={validity}
                        onChange={(value) => {
                          userEdited.current = true;
                          setValidity(value);
                          saveMutation.clearError();
                        }}
                        options={[
                          {
                            value: "default",
                            label: interpolate(copy.validityDefault, {
                              days: String(DISCOVERY_TLS_ORIGIN_CA_DEFAULT_VALIDITY_DAYS),
                            }),
                          },
                          ...DISCOVERY_TLS_ORIGIN_CA_VALIDITY_DAYS.map((days) => ({
                            value: String(days),
                            label: interpolate(copy.validityDays, { days: String(days) }),
                          })),
                        ]}
                        disabled={saveMutation.busy || ensureMutation.busy}
                      />,
                    )}
                    <p className="text-xs text-muted-foreground">{copy.originCaNote}</p>
                  </>
                )}
                {wildcard && provider === "letsencrypt" && (
                  <p className="text-xs text-warning">{copy.wildcardLetsencryptNote}</p>
                )}
                {policy.state === "configuration_required" && (
                  <p className="text-xs text-warning">{copy.configurationRequired}</p>
                )}
                {saveMutation.permissionDenied ? (
                  <p role="alert" className="text-sm text-danger">
                    {copy.permissionDenied}
                  </p>
                ) : saveMutation.error ? (
                  <p role="alert" className="text-sm text-danger">
                    {saveMutation.error}
                  </p>
                ) : savedNote ? (
                  <p role="status" className="text-sm text-muted-foreground">
                    {copy.saved}
                  </p>
                ) : null}
              </form>

              <section className="space-y-2 rounded-2xl bg-card p-4">
                <h3 className="text-sm font-medium">{copy.operation}</h3>
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm">
                  <span className="text-muted-foreground">{copy.expiry}</span>
                  <span className="font-medium">
                    {service.tls?.sslExpiresAt
                      ? new Date(service.tls.sslExpiresAt).toLocaleDateString(locale ?? undefined)
                      : copy.expiryUnknown}
                  </span>
                </div>
                {activeOperation ? (
                  <p className="text-xs text-muted-foreground">
                    {operationStateLabel(activeOperation.state)}
                    {activeOperation.reason ? ` · ${activeOperation.reason}` : ""}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">{copy.operationNone}</p>
                )}
                {!service.containerRunning && (
                  <p className="text-xs text-warning">{copy.stoppedBackend}</p>
                )}
              </section>

              {/* Service addressing is declaration state, not configuration: the
                  labels/env that control it are named so an operator knows
                  where to change them — this form never offers port overrides. */}
              <details className="rounded-2xl bg-card p-4">
                <DisclosureSummary>{copy.portsTitle}</DisclosureSummary>
                <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
                  <div>
                    <dt className="text-xs text-muted-foreground">{copy.containerPort}</dt>
                    <dd className="mt-1 font-medium">
                      {service.port ? `:${service.port}` : copy.notResolved}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">{copy.hostPort}</dt>
                    <dd className="mt-1 font-medium">
                      {service.hostPort ? `:${service.hostPort}` : copy.notResolved}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">{copy.network}</dt>
                    <dd className="mt-1 font-medium">{service.networkName ?? copy.notResolved}</dd>
                  </div>
                </dl>
                <p className="mt-3 text-xs text-muted-foreground">{copy.portsNote}</p>
              </details>
            </>
          )}
        </div>

        {policy && (
          <footer className="space-y-3 border-t border-border/50 px-5 py-4">
            <p className="text-xs text-muted-foreground">{copy.saveVsInstall}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                disabled={
                  saveMutation.busy || ensureMutation.busy || credentialBusy || addingCredential
                }
                onClick={() => void saveConfiguration()}
              >
                <UiIcon
                  name={saveMutation.busy ? "spinner" : "check"}
                  className={saveMutation.busy ? "animate-spin" : ""}
                />
                {saveMutation.busy ? copy.saving : copy.save}
              </Button>
              <Button
                variant="secondary"
                disabled={
                  saveMutation.busy || ensureMutation.busy || credentialBusy || addingCredential
                }
                onClick={() => void ensureCertificate()}
                title={copy.ensureHint}
              >
                <UiIcon
                  name={ensureMutation.busy ? "spinner" : "refresh"}
                  className={ensureMutation.busy ? "animate-spin" : ""}
                />
                {ensureMutation.busy ? copy.ensuring : activeOperation ? copy.retry : copy.ensure}
              </Button>
              {ensureMutation.permissionDenied ? (
                <p role="alert" className="w-full text-sm text-danger">
                  {copy.permissionDenied}
                </p>
              ) : ensureMutation.error ? (
                <p role="alert" className="w-full text-sm text-danger">
                  {ensureMutation.error}
                </p>
              ) : ensureNote ? (
                <p role="status" className="w-full text-sm text-muted-foreground">
                  {ensureNote}
                </p>
              ) : null}
            </div>
          </footer>
        )}
      </div>
    </Drawer>
  );
}
