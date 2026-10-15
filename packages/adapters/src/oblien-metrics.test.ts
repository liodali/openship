import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { Oblien } from "./oblien";
import { workspaceMetricsStream } from "./oblien-metrics";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const frame = (data: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);

it("keeps provider credentials server-side, rejects redirects and releases the reader on early return", async () => {
  const cancel = vi.fn();
  const fetcher = vi.fn(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(frame({ cpuUsage: 12.5 }));
          },
          cancel,
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  const client = new Oblien({ token: "old-token" });
  client.setToken("scoped-token");
  for await (const value of client.streamWorkspaceMetrics("ws-owned")) {
    expect(value).toEqual({ cpuUsage: 12.5 });
    break;
  }
  expect(cancel).toHaveBeenCalledOnce();
  const [url, request] = fetcher.mock.calls[0]! as unknown as [URL, RequestInit];
  expect(url.href).toBe("https://api.oblien.com/workspace/ws-owned/stats/stream");
  expect(request.redirect).toBe("error");
  expect(new Headers(request.headers).get("Authorization")).toBe("Bearer scoped-token");
  expect(request.signal?.aborted).toBe(true);
});
it("aborts a real provider socket while waiting for the next frame", async () => {
  let closed!: () => void;
  const closure = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: {"cpuUsage":1}\n\n`);
    request.on("close", closed);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as { port: number };
    const abort = new AbortController();
    const source = new Oblien({ token: "test", baseUrl: `http://127.0.0.1:${address.port}` })
      .streamWorkspaceMetrics("owned", abort.signal)
      [Symbol.asyncIterator]();
    expect((await source.next()).value).toEqual({ cpuUsage: 1 });
    const waiting = source.next();
    abort.abort();
    await expect(waiting).rejects.toThrow();
    await closure;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
it("rejects private provider error bodies and oversized incomplete frames", async () => {
  const open = async () => new Response("private-token", { status: 403 });
  await expect(workspaceMetricsStream(open).next()).rejects.toThrow(
    "Live resource usage is unavailable",
  );
  const oversized = async () =>
    new Response(`data: ${"x".repeat(70_000)}`, {
      headers: { "content-type": "text/event-stream" },
    });
  await expect(workspaceMetricsStream(oversized).next()).rejects.toThrow(
    "Invalid live resource usage",
  );
});
it("bounds a provider connection that never responds", async () => {
  vi.useFakeTimers();
  const source = workspaceMetricsStream(
    (signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  );
  const waiting = expect(source.next()).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(45_000);
  await waiting;
  expect(vi.getTimerCount()).toBe(0);
});
