import { AppError } from "@repo/core";
import { repos, type ClusterDatabaseRecord, type Project } from "@repo/db";
import { ClusterDatabaseAdapter, clusterDatabaseUrl } from "@repo/adapters";
import { decrypt } from "../../lib/encryption";
import { openClusterApi } from "../../lib/cluster-deployment-target";

export const clusterDatabaseOutputId = (id: string) => "cluster-database:" + id;

/** Native database outputs use the existing authenticated project connection surface. */
export async function nativeDatabaseOutputs(project: Project) {
  const rows = await repos.clusterDatabase.list(project.organizationId, project.id);
  return rows.map((row) => ({
    id: clusterDatabaseOutputId(row.id),
    sourceDatabaseId: row.id,
    clusterId: row.clusterId,
    label: row.name,
    service: null,
    secret: true,
    internal: true,
    envKey: row.config.engine === "postgres" ? "DATABASE_URL" : "REDIS_URL",
    width: "full" as const,
    value:
      row.status === "ready" && row.intent !== "remove"
        ? clusterDatabaseUrl(row.id, row.config, decrypt(row.secretEncrypted))
        : "",
  }));
}

export async function requireNativeDatabaseConnection(
  source: Project,
  target: Project,
  databaseId: string,
) {
  if (
    source.organizationId !== target.organizationId ||
    source.deletionInProgress ||
    target.deletionInProgress
  )
    throw new AppError(
      "This database connection is unavailable.",
      409,
      "CLUSTER_CONNECTION_UNAVAILABLE",
    );
  const row = await repos.clusterDatabase.get(source.organizationId, source.id, databaseId);
  if (
    row.status !== "ready" ||
    row.intent === "remove" ||
    target.workspaceId ||
    target.clusterId !== row.clusterId
  )
    throw new AppError(
      "Connect a ready database to a project on the same native cluster.",
      409,
      "CLUSTER_CONNECTION_UNAVAILABLE",
    );
  return row;
}

/** Read current grants on every deployment/restoration, never trust a saved URL as authorization. */
export async function sharedNativeDatabases(
  organizationId: string,
  projectId: string,
  runtimeId: string,
) {
  const target = await repos.project.findByIdInOrganization(projectId, organizationId);
  if (!target || target.deletionInProgress)
    throw new AppError("Project is unavailable.", 404, "PROJECT_NOT_FOUND");
  const result: Array<{ databaseId: string; projectId: string }> = [];
  for (const link of await repos.projectConnection.listByTarget(projectId)) {
    if (!link.sourceDatabaseId) continue;
    const source = await repos.project.findByIdInOrganization(link.sourceProjectId, organizationId);
    if (
      !source ||
      link.sourceServiceId ||
      link.mode !== "internal" ||
      !link.usesPrivateNetwork ||
      link.organizationId !== organizationId ||
      link.outputId !== clusterDatabaseOutputId(link.sourceDatabaseId)
    )
      throw new AppError(
        "This database connection has changed. Reconnect it before deploying.",
        409,
        "CLUSTER_CONNECTION_UNAVAILABLE",
      );
    const database = await requireNativeDatabaseConnection(source, target, link.sourceDatabaseId);
    if (database.runtimeId !== runtimeId)
      throw new AppError(
        "The shared database belongs to a different cluster installation.",
        409,
        "CLUSTER_CONNECTION_UNAVAILABLE",
      );
    result.push({ databaseId: database.id, projectId: source.id });
  }
  return result;
}

export async function nativeDatabaseConsumers(
  row: ClusterDatabaseRecord,
  excludeLinkIds?: ReadonlySet<string>,
) {
  const result: string[] = [];
  for (const link of await repos.projectConnection.listBySourceDatabase(row.id)) {
    if (excludeLinkIds?.has(link.id)) continue;
    const target = await repos.project.findByIdInOrganization(
      link.targetProjectId,
      row.organizationId,
    );
    if (
      !link.sourceServiceId &&
      link.mode === "internal" &&
      link.usesPrivateNetwork &&
      link.organizationId === row.organizationId &&
      link.sourceProjectId === row.projectId &&
      link.outputId === clusterDatabaseOutputId(row.id) &&
      target?.clusterId === row.clusterId &&
      !target.deletionInProgress &&
      !target.workspaceId
    )
      result.push(target.id);
  }
  return [...new Set(result)].sort();
}

/** Declare access only for persisted grants; revocation completes before the link is deleted. */
export async function reconcileNativeDatabaseConnections(
  organizationId: string,
  sourceProjectId: string,
  databaseId: string,
  excludeLinkIds?: ReadonlySet<string>,
) {
  const row = await repos.clusterDatabase.get(organizationId, sourceProjectId, databaseId);
  if (row.status === "deleted") return;
  const connection = await openClusterApi(organizationId, row.clusterId, row.runtimeId);
  try {
    const fence = async () => {
      const current = await repos.clusterDatabase.get(organizationId, sourceProjectId, databaseId);
      if (current.generation !== row.generation || !["ready", "retained"].includes(current.status))
        throw new AppError(
          "Database setup changed. Retry the connection after it finishes.",
          409,
          "CLUSTER_CONNECTION_UNAVAILABLE",
        );
    };
    const adapter = new ClusterDatabaseAdapter(
      connection.api,
      {
        ...row,
        hosts: connection.runtime.plan.hosts,
      },
      new AbortController().signal,
      fence,
    );
    await adapter.reconcileConnections(await nativeDatabaseConsumers(row, excludeLinkIds));
  } finally {
    await connection.api.dispose();
  }
}
