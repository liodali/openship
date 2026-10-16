import {
  parseInput,
  EnsureProjectBody,
  BuildAccessBody,
  type ProjectOperations,
  type SourceOperations,
  type DeploymentOperations,
  type SourceScan,
} from "@repo/contracts";
import type { DeploySourceInput, SourceDeploymentResult } from "./source-input";
import { runtimeNeedsInstall } from "@repo/core";

/**
 * Scan endpoints → BuildAccessBody.publicEndpoints. The scan shape reuses
 * EnsureProjectBody's endpoint (numeric `port`), while the deploy request's
 * PublicEndpointInput takes the port as a STRING (the wizard stringifies its
 * ports too) — parseInput is strict Value.Check, so the pass-through must
 * convert or the deploy 400s.
 */
function buildAccessEndpoint(endpoint: NonNullable<SourceScan["publicEndpoints"]>[number]) {
  return {
    ...(endpoint.port !== undefined ? { port: String(endpoint.port) } : {}),
    ...(endpoint.targetPath !== undefined ? { targetPath: endpoint.targetPath } : {}),
    ...(endpoint.domain !== undefined ? { domain: endpoint.domain } : {}),
    ...(endpoint.customDomain !== undefined ? { customDomain: endpoint.customDomain } : {}),
    ...(endpoint.domainType !== undefined ? { domainType: endpoint.domainType } : {}),
    ...(endpoint.redirectTo !== undefined ? { redirectTo: endpoint.redirectTo } : {}),
    ...(endpoint.redirectStatus !== undefined ? { redirectStatus: endpoint.redirectStatus } : {}),
  };
}

/** Identical orchestration for native and remote sources; transports only stage the bytes. */
export async function deploySourceWorkflow(ship: { projects: ProjectOperations; sources: SourceOperations; deployments: DeploymentOperations }, input: DeploySourceInput): Promise<SourceDeploymentResult> {
  const { source, signal, onStep } = input;
  const step = (message: string) => { signal?.throwIfAborted(); onStep?.(message); };
  step("Preparing source");
  const session = await ship.sources.stage({ source, name: input.name, projectId: input.projectId, serverId: input.serverId }, { signal, onStep });
  step("Detecting build config");
  const scan = await ship.sources.scan(session.sessionId);
  const serverId = scan.serverId ?? session.serverId ?? input.serverId;
  const services = scan.services?.map(service => ({ ...service, commandArgv: service.commandArgv ?? undefined }));
  // Declared domains (openship.json `domains[]`, normalized by the scan) must
  // reach BOTH the project record and the deploy request. Without them a
  // self-hosted server deploy fails the Cloud preflight
  // (hasManagedProjectDomain → "Connect Openship Cloud to use a free
  // subdomain") — the dashboard wizard sends these, the SDK didn't.
  const publicEndpoints = scan.publicEndpoints;
  step("Creating project");
  const hasBuild = Boolean(scan.buildCommand) || runtimeNeedsInstall(scan.stack, scan.runtimeVersion, scan.installCommand), hasServer = scan.workloadType !== "worker" && Boolean(scan.startCommand);
  const ensured = await ship.projects.ensure(parseInput(EnsureProjectBody, {
    name: scan.name || input.name || "app", projectId: input.projectId, serverId,
    deploymentEnvironment: input.environment,
    gitProvider: "upload", uploadSessionId: session.sessionId,
    framework: scan.stack, projectType: scan.projectType, packageManager: scan.packageManager,
    installCommand: scan.installCommand, buildCommand: scan.buildCommand, startCommand: scan.startCommand || undefined,
    releaseCommands: scan.releaseCommands,
    roles: scan.roles,
    outputDirectory: scan.outputDirectory, rootDirectory: scan.rootDirectory, buildImage: scan.buildImage, runtimeVersion: scan.runtimeVersion, runtimeImage: scan.runtimeImage,
    productionPaths: Array.isArray(scan.productionPaths) ? scan.productionPaths.join(",") : undefined,
    hasBuild, hasServer, productionMode: scan.productionMode ?? (hasServer ? "standalone" : "static"),
    workloadType: scan.workloadType, runtimeMode: scan.runtimeMode,
    ...(hasServer && scan.port ? { port: scan.port } : {}),
    ...(services?.length ? { services } : {}),
    ...(publicEndpoints?.length ? { publicEndpoints } : {}),
    monorepoApps: scan.monorepoApps, monorepoWorkspace: scan.monorepoWorkspace,
    composePath: scan.composePath, volumes: scan.volumes, routingConfig: scan.routing,
  }));
  step("Deploying");
  const deployment = await ship.deployments.buildAccess(parseInput(BuildAccessBody, {
    projectId: ensured.project_id, uploadSessionId: session.sessionId,
    ...(serverId ? { serverId } : {}),
    environment: input.environment,
    ...(services?.length ? { services } : {}),
    ...(publicEndpoints?.length ? { publicEndpoints: publicEndpoints.map(buildAccessEndpoint) } : {}),
    ...(input.serviceIds?.length ? { serviceIds: input.serviceIds } : {}),
  }));
  return { deployment_id: deployment.deployment_id, project_id: deployment.project_id,
    ...(scan.configDiagnostics && { configDiagnostics: scan.configDiagnostics }) };
}
