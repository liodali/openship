import { isIP } from "node:net";
import type { CommandExecutor } from "../types";
import { sq } from "./local-shell";
import { probeTcpDetailed, type TcpProbeResult } from "./reachability";

// The container Edge already carries Python through certbot. Probe TCP only:
// no HTTP request, redirects, proxy environment, or application-side effects.
const PROBE = `import errno,json,socket,sys
try:
    with socket.create_connection((sys.argv[1],int(sys.argv[2])),float(sys.argv[3])):
        print(json.dumps({"ok":True}))
except OSError as e:
    reason = "timeout" if isinstance(e, TimeoutError) else "refused" if e.errno in (errno.ECONNREFUSED,errno.ECONNRESET) else "no_route" if e.errno in (errno.EHOSTUNREACH,errno.ENETUNREACH,errno.ENETDOWN) else "error"
    print(json.dumps({"ok":False,"reason":reason}))
`;

/** Only the provider knows the executor/namespace in which OpenResty dials. */
export async function probeEdgeUpstream(
  executor: Pick<CommandExecutor, "exec"> | null,
  host: string,
  port: number,
  timeoutMs = 2000,
): Promise<TcpProbeResult> {
  if (!isIP(host) || host === "0.0.0.0" || host === "::" ||
      !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    return { ok: false, reason: "error", message: "Upstream must be a concrete IP address and TCP port" };
  }
  const timeout = Math.min(5000, Math.max(100, timeoutMs));
  if (!executor) return probeTcpDetailed(host, port, timeout);
  try {
    const command = ["python3", "-c", PROBE, host, String(port), String(timeout / 1000)]
      .map(sq).join(" ");
    const output = await executor.exec(command, { timeout: timeout + 2000 });
    const result = JSON.parse(output.trim()) as Record<string, unknown>;
    if (result.ok === true) return { ok: true };
    if (result.ok === false && ["timeout", "refused", "no_route", "error"].includes(String(result.reason))) {
      return { ok: false, reason: result.reason as "timeout" | "refused" | "no_route" | "error" };
    }
    return { ok: false, reason: "error", message: "Edge returned an invalid TCP probe result" };
  } catch {
    // Never fall back to the API/host namespace when the Edge cannot answer.
    return { ok: false, reason: "error", message: "Could not run TCP probe in Edge; check its executor and Python availability" };
  }
}
