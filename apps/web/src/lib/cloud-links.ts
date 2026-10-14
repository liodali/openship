import { CLOUD_DASHBOARD_URL } from "@repo/core";

/** Cloud owns authentication and checkout; keep the purchase intent in its URL. */
export function cloudPlanHref(planId?: string): string {
  const url = new URL("/billing/plans", CLOUD_DASHBOARD_URL);
  url.searchParams.set("newServer", "1");
  if (planId) {
    url.searchParams.set("plan", planId);
    url.searchParams.set("startCheckout", "1");
  }
  return url.toString();
}
