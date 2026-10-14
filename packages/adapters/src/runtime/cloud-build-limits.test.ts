import { describe, expect, it, vi } from "vitest";
import { DockerRuntime } from "./docker";
import { BuildLogger } from "./build-pipeline";
import type { BuildConfig, LogCallback, LogEntry } from "../types";

const config = {
  projectId: "project",
  sessionId: "build",
  resources: { cpuCores: 0.25, memoryMb: 512, diskMb: 8192 },
} as BuildConfig;
function fixture(transport = "cloud", buildKit = true, resources = config.resources) {
  const executor = {
    exec: vi.fn(async (command: string) =>
      command.includes("buildx version") && buildKit ? "OPENSHIP_BUILDKIT_OK\n" : "",
    ),
    streamExec: vi.fn(async (_command: string, _logger: unknown, _options: unknown) => ({
      code: 0,
      output: "",
    })),
  };
  const runtime = Object.assign(Object.create(DockerRuntime.prototype), {
    transport: { kind: transport },
    connectionOptions: { transport, executor },
  });
  return {
    executor,
    run: (signal?: AbortSignal, onLog?: LogCallback) =>
      runtime.buildImageOnRemote(
        { ...config, resources },
        "/tmp/build dir",
        "Dockerfile",
        "openship/test:build",
        new BuildLogger(onLog),
        { signal },
      ),
  };
}

describe("Cloud Docker build execution limits", () => {
  it.each(["cloud", "ssh"])("preserves fragmented %s terminal output without adding line breaks", async transport => {
    const h = fixture(transport);
    const original = "#5 installing dependencies\r\n#5 café ready\r\n";
    const bytes = Buffer.from(original);
    const fragments = [bytes.subarray(0, 3), bytes.subarray(3, 12), bytes.subarray(12, 36), bytes.subarray(36)];
    h.executor.streamExec.mockImplementation(async (_command, logger) => {
      for (const fragment of fragments) (logger as LogCallback)({
        timestamp: new Date().toISOString(), message: fragment.toString(),
        level: "info", rawData: fragment.toString("base64"),
      });
      return { code: 0, output: original };
    });
    const logs: LogEntry[] = [];
    await h.run(undefined, entry => logs.push(entry));
    const streamed = logs.filter(entry => entry.rawData !== undefined);
    expect(Buffer.concat(streamed.map(entry => Buffer.from(entry.rawData!, "base64"))).toString()).toBe(original);
  });
  it.each(["cloud", "ssh"])("omits all build limits when unset on %s", async transport => {
    const h = fixture(transport, true, { cpuCores: 0, memoryMb: 0, diskMb: 0 });
    await h.run();
    const command = h.executor.streamExec.mock.calls[0]![0];
    expect(command).not.toContain("--driver-opt"); expect(command).not.toContain("--memory"); expect(command).not.toContain("--cpu-quota");
    if (transport === "cloud") {
      expect(command).toContain("--driver docker-container");
      expect(h.executor.exec.mock.calls.at(-1)![0]).toContain("buildx rm --force");
    }
  });
  it("applies only an explicitly configured dimension", async () => {
    const h = fixture("cloud", true, { cpuCores: 0, memoryMb: 512, diskMb: 0 });
    await h.run();
    const command = h.executor.streamExec.mock.calls[0]![0];
    expect(command).toContain("memory=536870912"); expect(command).not.toContain("cpu-quota=");
  });
  it("runs BuildKit inside the selected CPU/RAM budget and loads its image into the project's Docker host", async () => {
    const h = fixture();
    await h.run();
    const command = h.executor.streamExec.mock.calls[0]![0];
    expect(command).toContain("--driver docker-container");
    expect(command).toContain("--driver-opt 'memory=536870912'");
    expect(command).toContain("--driver-opt 'memory-swap=536870912'");
    expect(command).toContain("--driver-opt 'cpu-quota=25000'");
    expect(command).toContain("--driver-opt 'cpu-period=100000'");
    expect(command).toContain("--load --progress=plain");
    expect(command).toContain("cd '/tmp/build dir'");
    expect(command).not.toContain("--use");
    expect(command).toContain("trap ");
    expect(h.executor.exec.mock.calls.at(-1)![0]).toContain("buildx rm --force 'openship-");
    expect(command).not.toContain("--keep-state");
    expect(h.executor.exec.mock.calls.at(-1)![0]).not.toContain("--keep-state");
  });
  it.each([1, 137])(
    "removes the project's builder and cache after a failed build (exit %s)",
    async (code) => {
      const h = fixture();
      h.executor.streamExec.mockResolvedValue({ code, output: "" });
      await expect(h.run()).rejects.toThrow(`docker build exited with code ${code}`);
      expect(h.executor.exec.mock.calls.at(-1)![0]).toContain("buildx rm --force 'openship-");
      expect(h.executor.exec.mock.calls.at(-1)![0]).not.toContain("--keep-state");
      expect(h.executor.exec.mock.calls.at(-1)![0]).not.toContain("prune");
    },
  );
  it("cleans up the builder after cancellation even if the remote stream resolves normally", async () => {
    const h = fixture();
    const controller = new AbortController();
    h.executor.streamExec.mockImplementation(async () => {
      controller.abort();
      return { code: 0, output: "" };
    });
    await expect(h.run(controller.signal)).rejects.toMatchObject({ name: "BuildCancelledError" });
    expect(h.executor.exec.mock.calls.at(-1)![0]).toContain("buildx rm --force 'openship-");
    expect(h.executor.exec.mock.calls.at(-1)![0]).not.toContain("--keep-state");
  });
  it("applies the same budget to the legacy Cloud Docker builder", async () => {
    const h = fixture("cloud", false);
    await h.run();
    const command = h.executor.streamExec.mock.calls[0]![0];
    expect(command).toContain("--memory 536870912 --memory-swap 536870912");
    expect(command).toContain("--cpu-quota 25000 --cpu-period 100000");
    expect(command).not.toContain("buildx create");
  });
  it.each([true, false])(
    "keeps the self-hosted SSH build path unchanged (BuildKit: %s)",
    async (buildKit) => {
      const h = fixture("ssh", buildKit);
      await h.run();
      const command = h.executor.streamExec.mock.calls[0]![0];
      expect(command).not.toContain("--memory");
      expect(command).not.toContain("--cpu-quota");
      expect(command).not.toContain("buildx create");
    },
  );
});
