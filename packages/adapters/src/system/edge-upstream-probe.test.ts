import { describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { probeEdgeUpstream } from "./edge-upstream-probe";
import { edgeContainerExecutor } from "./edge-container-executor";
import type { CommandExecutor } from "../types";
import { NginxProvider } from "../infra/nginx";
import { OPENRESTY_DEFAULT_PATHS } from "../infra/openresty-lua";
import type { RootChecked } from "./privilege";

describe("Edge upstream TCP probe", () => {
  it("executes in the Edge container namespace with a bounded command", async () => {
    const inner = { exec: vi.fn(async (_command: string, _options?: { timeout?: number }) => '{"ok":true}') };
    const executor = edgeContainerExecutor(inner as unknown as CommandExecutor, "openship-edge");
    expect(await probeEdgeUpstream(executor, "172.20.0.5", 3000)).toEqual({ ok: true });
    expect(inner.exec.mock.calls[0][0]).toContain("docker exec 'openship-edge' sh -c");
    expect(inner.exec).toHaveBeenCalledWith(expect.stringContaining("python3"), { timeout: 4000 });
  });

  it("treats a failed Edge executor as failure, with no host-side fallback", async () => {
    const exec = vi.fn(async () => { throw new Error("edge down"); });
    expect(await probeEdgeUpstream({ exec }, "127.0.0.1", 80)).toMatchObject({ ok: false, reason: "error" });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("uses the routing provider's Edge executor for the probe", async () => {
    const exec = vi.fn(async () => '{"ok":false,"reason":"no_route"}');
    const provider = new NginxProvider({ paths: OPENRESTY_DEFAULT_PATHS,
      executor: { exec } as unknown as RootChecked, containerEdge: true });
    expect(await provider.probeUpstream("172.20.0.5", 3000)).toEqual({ ok: false, reason: "no_route" });
    expect(exec).toHaveBeenCalledWith(expect.stringContaining("python3"), { timeout: 4000 });
  });

  it("rejects malformed targets without executing a shell", async () => {
    const exec = vi.fn();
    for (const host of ["0.0.0.0", "::", "localhost", "127.0.0.1; id", "$(id)"]) {
      expect(await probeEdgeUpstream({ exec }, host, 3000)).toMatchObject({ ok: false });
    }
    expect(await probeEdgeUpstream({ exec }, "127.0.0.1", 65536)).toMatchObject({ ok: false });
    expect(exec).not.toHaveBeenCalled();
  });

  it("requires a valid structured response from Edge", async () => {
    expect(await probeEdgeUpstream({ exec: async () => "not json" }, "127.0.0.1", 3000)).toMatchObject({ ok: false });
    expect(await probeEdgeUpstream({ exec: async () => '{"ok":false,"reason":"refused"}' }, "127.0.0.1", 3000))
      .toEqual({ ok: false, reason: "refused" });
  });

  it("the executed Python probe dials TCP without sending an HTTP request", async () => {
    let received = 0;
    const sockets: import("node:net").Socket[] = [];
    const server = createServer((socket) => {
      sockets.push(socket);
      socket.on("data", (data) => { received += data.length; });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const port = (server.address() as import("node:net").AddressInfo).port;
    const run = promisify(execFile);
    try {
      const result = await probeEdgeUpstream({ exec: async (command) =>
        (await run("sh", ["-c", command])).stdout }, "127.0.0.1", port);
      expect(result).toEqual({ ok: true });
      expect(received).toBe(0);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(await probeEdgeUpstream(null, "127.0.0.1", port)).toMatchObject({ ok: false, reason: "refused" });
  });
});
