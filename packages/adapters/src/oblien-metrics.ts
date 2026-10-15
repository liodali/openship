import { parseSSEChunks } from "@repo/core";

/** A metrics subscription owns its fetch and reader. Bound stalled connections
 * and incomplete frames without changing the SDK's other SSE operations. */
export async function* workspaceMetricsStream(
  open: (signal: AbortSignal) => Promise<Response>,
  signal?: AbortSignal,
): AsyncGenerator<unknown> {
  const abort = new AbortController();
  const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
  let deadline: ReturnType<typeof setTimeout>;
  const arm = () => {
    clearTimeout(deadline);
    deadline = setTimeout(() => abort.abort(new Error("Live usage stream timed out")), 45_000);
    deadline.unref?.();
  };
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  arm();
  try {
    combined.throwIfAborted();
    const response = await open(combined);
    if (
      !response.ok ||
      !response.body ||
      !response.headers.get("content-type")?.includes("text/event-stream")
    ) {
      await response.body?.cancel();
      throw new Error("Live resource usage is unavailable. Retry to reconnect.");
    }
    reader = response.body.getReader();
    let frameBytes = 0;
    const chunks = {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const chunk = await reader!.read();
          if (chunk.done) return;
          arm();
          frameBytes += chunk.value.byteLength;
          if (frameBytes > 65_536) throw new Error("Invalid live resource usage response");
          yield chunk.value;
        }
      },
    };
    for await (const event of parseSSEChunks(chunks)) {
      combined.throwIfAborted();
      frameBytes = 0;
      if (event.event === "error")
        throw new Error("Live resource usage is unavailable. Retry to reconnect.");
      let sample: unknown;
      try {
        sample = JSON.parse(event.data);
      } catch {
        throw new Error("Invalid live resource usage response");
      }
      yield sample;
    }
  } finally {
    clearTimeout(deadline!);
    abort.abort();
    if (reader) {
      try {
        await reader.cancel();
      } catch {
        /* diagnostics-ignore: cancellation only releases this read-only subscription. */
      }
      reader.releaseLock();
    }
  }
}
