"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";
import { systemApi } from "@/lib/api";
import type { ServerInfo } from "@/lib/api/system";
import { useResourceScope, useScopedResource } from "@/hooks/use-scoped-resource";
import { DiscoveryCard } from "@/components/discovery/discovery-card";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { PageContainer } from "@/components/ui/PageContainer";
import { useI18n } from "@/components/i18n-provider";

/**
 * Dedicated container-discovery page — the rail's Discovery entry.
 *
 * One page over every accessible server: the server selector IS the URL
 * (`?server=<id>`), so the rail entry, the server page's "Manage discovery"
 * shortcut and pasted deep links all resolve the same state, and a selection
 * survives a reload.
 *
 * The page only scopes WHICH server; everything else belongs to the shared
 * DiscoveryCard. It never consults a component health check — visibility
 * depends on server access, and when Podman/Docker is unreachable the card
 * shows the runtime error and Retry instead of disappearing. The list itself
 * is `system/servers`; managed (cloud-workspace) rows are filtered out
 * because they can't run discovery — the server page never renders the card
 * for them either, so offering them in the selector would only dead-end at a
 * permission line.
 *
 * The list read runs through the shared scoped-resource hook: its owner check
 * drops the previous account's rows the moment the session/workspace/cloud
 * scope changes (another tab switching workspaces does NOT reload the page),
 * and the card is keyed by scope AND server id, so a status read from one
 * account can never survive into the next.
 */
export default function DiscoveryPage() {
  const { t } = useI18n();
  const s = t.servers.discovery;
  const p = s.page;
  const router = useRouter();
  const searchParams = useSearchParams();
  const serverParam = searchParams.get("server");

  /** Session user + active workspace + cloud resource — the same identity the
   *  API's X-Organization-Id header and the sidebar's org switcher follow. */
  const scope = useResourceScope();

  const {
    data: servers,
    error: listError,
    loading: listLoading,
    refresh: reloadServers,
  } = useScopedResource(
    useCallback(async () => {
      const list = await systemApi.listServers();
      return (list ?? []).filter((server) => !server.managed);
    }, []),
  );

  /**
   * Resolve the selection. The URL wins when it names an accessible server;
   * without one the first accessible server is the landing selection. A param
   * that names an INACCESSIBLE server (removed, other workspace, no grant)
   * selects nothing — the card would only render a raw 404, so the page says
   * "not available" and leaves the choice to the selector. While the list is
   * in flight there is no selection at all, so a deep link never flashes the
   * wrong server before the list arrives.
   */
  const matched = servers?.find((server) => server.id === serverParam) ?? null;
  const selected = matched ?? (serverParam ? null : servers?.[0] ?? null);
  /** The deep link names a server the caller can't see (or that is gone). */
  const paramUnavailable = !!(servers && serverParam && !matched);

  // Landing without a param: write the implicit selection into the URL so the
  // address bar always names the server on screen (replace, not push — picking
  // a scope is not navigation the user backs through). One write per list.
  const autoSelectSignature = useRef<string | null>(null);
  useEffect(() => {
    if (!servers || serverParam || servers.length === 0) return;
    const signature = servers[0].id;
    if (autoSelectSignature.current === signature) return;
    autoSelectSignature.current = signature;
    router.replace(`/discovery?server=${encodeURIComponent(servers[0].id)}`, { scroll: false });
  }, [servers, serverParam, router]);

  const selectServer = useCallback(
    (id: string) => {
      router.replace(`/discovery?server=${encodeURIComponent(id)}`, { scroll: false });
    },
    [router],
  );

  const label = (server: ServerInfo) => server.name || server.sshHost || server.id;

  return (
    <PageContainer>
      <div className="mb-6">
        <h1 className="text-2xl font-medium text-foreground">{s.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{p.subtitle}</p>
      </div>

      {/* The page's scope: one filled select, matching the shared form-dropdown
          treatment. Disabled while the list loads, so a switch can't race it. */}
      <div className="mb-6 max-w-sm">
        <span className="mb-1.5 block text-[12px] font-medium text-muted-foreground">
          {p.serverLabel}
        </span>
        <CustomSelect<string>
          aria-label={p.serverLabel}
          value={selected?.id ?? ""}
          options={(servers ?? []).map((server) => ({
            value: server.id,
            label: label(server),
            description: server.name ? server.sshHost ?? undefined : undefined,
          }))}
          onChange={selectServer}
          placeholder={p.serverPlaceholder}
          variant="filled"
          triggerClassName="bg-muted/60 hover:bg-muted"
          disabled={!servers || servers.length === 0}
        />
      </div>

      {listError && (
        <section className="mb-6 rounded-2xl bg-card p-5">
          <p className="text-sm text-danger">{listError}</p>
          <button
            type="button"
            onClick={reloadServers}
            className="mt-3 inline-flex items-center gap-2 rounded-lg bg-muted/60 px-3 py-2 text-[12px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
          >
            <UiIcon name="refresh" className="size-3.5" />
            {s.retry}
          </button>
        </section>
      )}

      {listLoading && !servers && !listError ? (
        // List in flight (first load or scope change) — skeletons shaped like
        // the destination (Domains page).
        <div aria-busy="true" className="space-y-4">
          <div className="h-20 animate-pulse rounded-2xl bg-muted/50" />
          <div className="h-64 animate-pulse rounded-2xl bg-muted/50" />
        </div>
      ) : paramUnavailable ? null : servers && servers.length === 0 ? (
        <section className="flex flex-wrap items-center gap-4 rounded-2xl bg-card px-5 py-6">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-muted/50 text-muted-foreground">
            <UiIcon name="server" className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">{p.noServersTitle}</p>
            <p className="mt-1 text-sm text-muted-foreground">{p.noServersHint}</p>
          </div>
          <Link
            href="/servers/new"
            className="inline-flex items-center gap-2 rounded-xl bg-muted/40 px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
          >
            <UiIcon name="plus" className="size-4" />
            {p.noServersCta}
          </Link>
        </section>
      ) : selected ? (
        // Keyed remount per SCOPE and server: an account/workspace change and a
        // selector switch both drop the card's in-flight reads and stale state
        // wholesale (the hook aborts its own requests too), so a status read
        // from one account can never survive into the next.
        <DiscoveryCard key={`${scope}:${selected.id}`} serverId={selected.id} />
      ) : null}

      {paramUnavailable && (
        <section className="flex items-center gap-4 rounded-2xl bg-card px-5 py-6">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-muted/50 text-muted-foreground">
            <UiIcon name="server-off" className="size-5" />
          </div>
          <p className="min-w-0 text-sm text-muted-foreground">{p.serverUnavailable}</p>
        </section>
      )}
    </PageContainer>
  );
}
