import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionDependencies } from "../../../actions";
import type { ExecutionContext } from "../../../context";

const h = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../../config/index", () => ({ env: { CLOUD_MODE: false } }));
vi.mock("../../lib/cloud/resource-authority", () => ({
  canDiscoverCloudResources: () => true,
  resolveResourceAuthority: async () => "local",
}));
vi.mock("../../lib/cloud/scope", () => ({ assertCloudProxyScope: () => {} }));
vi.mock("../../lib/cloud/server-reference", () => ({
  cloudRequestReferences: async (_: string, input: unknown) => input,
}));
vi.mock("../../lib/cloud/transport", () => ({
  cloudFetchAsOrgOwner: h.fetch,
  resolveOrgCloudUserId: async () => "cloud-user",
}));
import { withCloudActions } from "./cloud-operations";

const ctx = { organizationId: "local-org" } as ExecutionContext;
const rows = [{ id: "local-row" }];

beforeEach(() => h.fetch.mockReset());

describe("Cloud Actions discovery", () => {
  it.each(["list", "listRuns", "runners", "projects"] as const)(
    "keeps local %s when Cloud is unreachable",
    async (name) => {
      h.fetch.mockResolvedValue(null);
      const local = {
        collection: { [name]: async () => rows },
        resources: {},
      } as unknown as ActionDependencies;
      expect(await withCloudActions(local).collection[name](ctx, {} as never)).toEqual(rows);
      expect(h.fetch).toHaveBeenCalledOnce();
    },
  );
});
