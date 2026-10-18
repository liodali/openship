"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { domainsApi, getApiErrorMessage, type DomainInventory } from "@/lib/api";
import { PageContainer } from "@/components/ui/PageContainer";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/i18n-provider";

type SslStrings = {
  sslActive: string;
  sslProvisioning: string;
  sslExpired: string;
  sslError: string;
  sslNone: string;
};

type SslBadge = {
  label: string;
  className: string;
  icon?: string;
};

function sslBadge(row: DomainInventory, m: SslStrings): SslBadge | null {
  if (row.redirectTo) return null;
  switch (row.sslStatus) {
    case "active":
      return { label: m.sslActive, className: "text-success" };
    case "provisioning":
      return { label: m.sslProvisioning, className: "text-info" };
    case "expired":
      return { label: m.sslExpired, className: "text-danger" };
    case "error":
      return { label: m.sslError, className: "text-danger" };
    default:
      return { label: m.sslNone, className: "text-muted-foreground" };
  }
}

export default function DomainsPage() {
  const { t } = useI18n();
  const m = t.misc.domains;
  const [rows, setRows] = useState<DomainInventory[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await domainsApi.listAll();
      setRows(response.data);
      setError(null);
    } catch (err) {
      setError(getApiErrorMessage(err, m.loadFailed));
    } finally {
      setLoading(false);
    }
  }, [m.loadFailed]);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = new Map<string, DomainInventory[]>();
  for (const row of rows ?? []) {
    const key = row.serverName ?? row.serverId ?? "";
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }

  return (
    <PageContainer>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-medium text-foreground">{m.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{m.subtitle}</p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => void load()}
          disabled={loading}
          aria-label={m.refresh}
          title={m.refresh}
        >
          <UiIcon name="refresh" className={`size-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {error != null && (
        <section className="rounded-2xl bg-card p-5">
          <p className="text-sm text-danger">{error}</p>
          <Button variant="secondary" size="sm" className="mt-3" onClick={() => void load()} disabled={loading}>
            {m.retry}
          </Button>
        </section>
      )}

      {loading && !rows ? (
        <div aria-busy="true" className="space-y-4">
          <div className="h-20 animate-pulse rounded-2xl bg-muted/50" />
          <div className="h-64 animate-pulse rounded-2xl bg-muted/50" />
        </div>
      ) : (
        <div className="space-y-5">
          {rows?.length === 0 && (
            <section className="flex items-center gap-4 rounded-2xl bg-card px-5 py-6">
              <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-muted/50 text-muted-foreground">
                <UiIcon name="globe" className="size-5" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">{m.emptyTitle}</p>
                <p className="mt-1 text-sm text-muted-foreground">{m.emptyDescription}</p>
              </div>
            </section>
          )}
          {[...groups.entries()].map(([server, list]) => (
            <section key={server} aria-label={server || m.unassigned} className="overflow-hidden rounded-2xl bg-card">
              <div className="flex items-center gap-2 px-5 py-4">
                <UiIcon name="server" className="size-4 text-muted-foreground" />
                <h2 className="text-sm font-medium text-foreground">
                  {server || m.unassigned}
                </h2>
                <span className="text-xs text-muted-foreground">
                  · {list.length}
                </span>
              </div>
              <ul className="divide-y divide-border/40">
                {list.map((row) => {
                  const ssl = sslBadge(row, m);
                  return (
                    <li key={row.id} className="group relative flex items-start gap-3 px-5 py-4 transition-colors hover:bg-muted/20">
                      {row.projectId && (
                        <Link
                          href={`/projects/${row.projectId}`}
                          aria-label={row.hostname}
                          className="absolute inset-0 z-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        />
                      )}
                      <div className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl bg-background text-muted-foreground">
                        <UiIcon name="globe" className="size-5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="truncate text-sm font-medium text-foreground">{row.hostname}</p>
                          {row.isPrimary && (
                            <UiIcon name="star" className="size-3 text-muted-foreground" aria-label={m.primary} />
                          )}
                          {row.redirectTo ? (
                            <span className="text-xs text-muted-foreground">
                              {m.redirectsTo} {row.redirectTo}
                            </span>
                          ) : row.verified ? (
                            <span className="inline-flex items-center gap-1 text-xs text-success">
                              <UiIcon name="check" className="size-3" />
                              {m.verified}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-xs text-warning">
                              <UiIcon name="clock" className="size-3" />
                              {m.pending}
                            </span>
                          )}
                          {ssl && <span className={`text-xs ${ssl.className}`}>{ssl.label}</span>}
                        </div>
                        <p className="mt-1 truncate text-xs text-muted-foreground">
                          {row.projectName ?? m.unassigned}
                          {row.targetPort != null ? ` :${row.targetPort}` : ""}
                          {row.targetPath ? row.targetPath : ""}
                        </p>
                        {row.sslExpiresAt && !row.redirectTo && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {m.expires} {new Date(row.sslExpiresAt).toLocaleDateString()}
                            {row.sslIssuer ? ` · ${row.sslIssuer}` : ""}
                          </p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </PageContainer>
  );
}
