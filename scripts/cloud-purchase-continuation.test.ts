import { expect, it } from "bun:test";
import { CLOUD_DASHBOARD_URL } from "@repo/core";
import { cloudPlanHref } from "../apps/web/src/lib/cloud-links";

it("sends a marketing plan choice directly to Cloud's new-server purchase", () => {
  const link = new URL(cloudPlanHref("starter"));
  expect(link.origin).toBe(new URL(CLOUD_DASHBOARD_URL).origin);
  expect(link.pathname).toBe("/billing/plans");
  expect(link.searchParams.get("newServer")).toBe("1");
  expect(link.searchParams.get("plan")).toBe("starter");
  expect(link.searchParams.get("startCheckout")).toBe("1");
  expect(new URL(cloudPlanHref()).searchParams.has("plan")).toBe(false);
  expect(new URL(cloudPlanHref()).searchParams.has("startCheckout")).toBe(false);
});

it("encodes the plan as a value so it cannot inject a host or another server", () => {
  const input = "starter&workspaceId=foreign#//evil.test";
  const link = new URL(cloudPlanHref(input));
  expect(link.origin).toBe(new URL(CLOUD_DASHBOARD_URL).origin);
  expect(link.searchParams.get("plan")).toBe(input);
  expect(link.searchParams.has("workspaceId")).toBe(false);
  expect(link.hash).toBe("");
});
