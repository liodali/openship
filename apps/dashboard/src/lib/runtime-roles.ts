import type { ProjectRuntimeRoles, RuntimeRole, RuntimeRoleContainer } from "@repo/contracts";

export type { ProjectRuntimeRoles, RuntimeRole, RuntimeRoleContainer } from "@repo/contracts";

export function runtimeRoleState(role: RuntimeRole): RuntimeRoleContainer["status"] {
  const states = role.containers.map((container) => container.status);
  if (states.includes("failed")) return "failed";
  if (states.includes("missing")) return "missing";
  if (states.includes("restarting")) return "restarting";
  if (!states.length || states.includes("unknown")) return "unknown";
  if (states.every((state) => state === "running")) return "running";
  if (states.every((state) => state === "stopped")) return "stopped";
  if (states.includes("starting")) return "starting";
  // A partly stopped role needs attention until its stopped replicas recover.
  return "failed";
}

export function roleLogsHref(
  projectId: string,
  deploymentId: string,
  name: string,
  replica: number,
) {
  const query = new URLSearchParams({ role: name, replica: String(replica), deploymentId });
  return `/projects/${encodeURIComponent(projectId)}/logs?${query}`;
}

export function roleLogTargetKey(deploymentId: string, name: string, replica: number) {
  return `role:${JSON.stringify([deploymentId, name, replica])}`;
}

export function runtimeRoleLogTargets(data: ProjectRuntimeRoles | null) {
  if (!data?.deploymentId) return [];
  const deploymentId = data.deploymentId;
  return data.roles.flatMap((role) =>
    role.containers
      .filter((replica) => replica.containerId)
      .map((replica) => ({
        value: roleLogTargetKey(deploymentId, role.name, replica.replica),
        role: role.name,
        replica: replica.replica,
        deploymentId,
        kind: role.kind,
      })),
  );
}
