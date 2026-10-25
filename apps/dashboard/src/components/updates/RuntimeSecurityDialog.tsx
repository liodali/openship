"use client";

import { SECURITY_FEED_SOURCE } from "@repo/core";
import type { SecurityOverview } from "@repo/contracts";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { useCloudResourceKey } from "@/context/CloudResourceContext";
import { Modal } from "@/components/ui/Modal";
import { SecurityProjectReview } from "./SecurityProjectReview";

export function RuntimeSecurityDialog({
  overview,
  onClose,
  onChecked,
}: {
  overview: SecurityOverview;
  onClose: () => void;
  onChecked: () => void;
}) {
  const { t } = useI18n();
  const copy = t.projectSettings.securityAdvisories;
  const resourceKey = useCloudResourceKey();
  return (
    <Modal isOpen onClose={onClose} width="760px" maxWidth="95vw" maxHeight="85vh">
      <div className="space-y-5 p-5 sm:p-6">
        <header className="space-y-2 pe-8">
          <h2 className="text-lg font-medium">{copy.title}</h2>
          <p className="text-sm text-muted-foreground">{copy.affected}</p>
          {!!overview.pendingProjects && (
            <p className="text-xs text-muted-foreground">
              {interpolate(copy.pendingApps, { count: overview.pendingProjects })}
            </p>
          )}
          {!!overview.unknownProjects && (
            <p className="text-xs text-muted-foreground">{copy.partial}</p>
          )}
        </header>
        {overview.projects.map((project) => (
          <SecurityProjectReview
            key={`${resourceKey}:${project.projectId}:${project.deploymentId}`}
            projectId={project.projectId}
            name={project.name}
            workspaceId={project.workspaceId}
            revision={project.deploymentId}
            initialResult={project}
            onChecked={onChecked}
          />
        ))}
        <p className="text-xs text-muted-foreground">
          {copy.notifications}{" "}
          <a
            href={SECURITY_FEED_SOURCE}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4"
          >
            {copy.publicFeed}
          </a>
        </p>
      </div>
    </Modal>
  );
}
