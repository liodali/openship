// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseDictionary } from "@/i18n";
import { LogsSettings } from "./LogsSettings";

const state = vi.hoisted(() => ({
  project: { name: "Example", deployTarget: "cloud", hasServer: false, workloadType: "static" },
  clearTerminalLogs: vi.fn(),
  clearServerLogs: vi.fn(),
  searchParams: new URLSearchParams(),
  router: { replace: vi.fn() },
  terminalLogsData: { logs: ["runtime output"] },
  serverLogsData: {
    logs: [
      {
        timestamp: "today",
        ip: "127.0.0.1",
        method: "GET",
        path: "/",
        statusCode: 200,
        responseTime: 5,
      },
    ],
  },
  servicesData: { isLoading: false, services: [] },
}));

vi.mock("@/context/ProjectSettingsContext", () => ({
  useProjectSettings: () => ({
    projectData: state.project,
    buildData: { isLoading: false },
    id: "project",
    terminalLogsData: state.terminalLogsData,
    serverLogsData: state.serverLogsData,
    clearTerminalLogs: state.clearTerminalLogs,
    clearServerLogs: state.clearServerLogs,
    servicesData: state.servicesData,
  }),
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => state.searchParams,
  useRouter: () => state.router,
}));
vi.mock("@/components/i18n-provider", () => ({
  useI18n: () => ({ t: baseDictionary }),
}));
vi.mock("./logs/TerminalLogs", () => ({
  TerminalLogs: ({ streamTarget }: { streamTarget: string }) => (
    <output data-stream={streamTarget}>Terminal output</output>
  ),
}));
vi.mock("./logs/ServerLogs", () => ({
  ServerLogs: () => <output>HTTP Request Logs</output>,
}));

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.project = {
    name: "Example",
    deployTarget: "cloud",
    hasServer: false,
    workloadType: "static",
  };
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const clearButton = () =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === baseDictionary.projectDetail.logs.actions.clear,
  )!;

describe("project log source controls", () => {
  it("shows static request logs without a redundant tab or dangling panel label", async () => {
    await act(async () => root.render(<LogsSettings />));
    expect(host.querySelector('[role="tablist"]')).toBeNull();
    expect(host.querySelector('[role="tabpanel"]')).toBeNull();
    expect(host.querySelector("[aria-labelledby]")).toBeNull();
    const region = host.querySelector('[role="region"]');
    expect(region?.getAttribute("aria-label")).toBe(baseDictionary.projectSettings.logs.requests);
    expect(region?.textContent).toBe("HTTP Request Logs");
    await act(async () => clearButton().click());
    expect(state.clearServerLogs).toHaveBeenCalledOnce();
    expect(state.clearTerminalLogs).not.toHaveBeenCalled();
  });

  it("keeps keyboard selection, panel labels and actions tied to the active runtime source", async () => {
    state.project = { ...state.project, hasServer: true, workloadType: "web" };
    await act(async () => root.render(<LogsSettings />));
    const tabs = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      baseDictionary.projectSettings.logs.terminal,
      baseDictionary.projectSettings.logs.server,
    ]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs[0].tabIndex).toBe(0);
    expect(tabs[1].tabIndex).toBe(-1);
    expect(host.querySelector("output")?.getAttribute("data-stream")).toBe(
      "projects/project/logs/stream",
    );
    tabs[0].focus();
    await act(async () =>
      tabs[0].dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
      ),
    );
    expect(document.activeElement).toBe(tabs[1]);
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    const panel = host.querySelector<HTMLElement>(
      `[id="${tabs[1].getAttribute("aria-controls")}"]`,
    )!;
    expect(panel.hidden).toBe(false);
    expect(panel.getAttribute("aria-labelledby")).toBe(tabs[1].id);
    expect(panel.textContent).toBe("HTTP Request Logs");
    await act(async () => clearButton().click());
    expect(state.clearServerLogs).toHaveBeenCalledOnce();
    expect(state.clearTerminalLogs).not.toHaveBeenCalled();

    await act(async () =>
      tabs[1].dispatchEvent(
        new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }),
      ),
    );
    expect(document.activeElement).toBe(tabs[0]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    await act(async () => clearButton().click());
    expect(state.clearTerminalLogs).toHaveBeenCalledOnce();
  });
});
