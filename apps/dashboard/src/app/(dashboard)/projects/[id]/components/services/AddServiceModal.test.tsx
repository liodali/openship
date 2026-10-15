// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { baseDictionary } from "@/i18n";
import { AddServiceModal } from "./AddServiceModal";
import { getAppTemplate } from "@repo/core";

const h = vi.hoisted(() => ({ mode: "cloud", submit: vi.fn(), close: vi.fn() }));
vi.mock("@/context/PlatformContext", () => ({ usePlatform: () => ({ deployMode: h.mode }) }));
vi.mock("@/context/CloudContext", () => ({ useCloud: () => ({ connected: true }) }));
vi.mock("@/components/ui/Modal", () => ({
  Modal: ({ isOpen, children }: { isOpen: boolean; children: ReactNode }) => isOpen ? children : null,
}));
vi.mock("../UseInProjectModal", () => ({ ProjectConnectionForm: () => null }));
vi.mock("@/components/import-project/EnvironmentVariables", () => ({ default: () => null }));
vi.mock("@/components/routing/RoutingSettingsCard", () => ({ RoutingSettingsCard: () => null }));

let host: HTMLDivElement;
let root: Root;
const copy = baseDictionary.projectDetail.services.addModal;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.mode = "cloud";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const render = (linkedCloud = false) => act(async () => root.render(
  <I18nProvider><AddServiceModal open projectName="Example" isCloudProject={linkedCloud} onClose={h.close} onSubmit={h.submit} /></I18nProvider>,
));
async function pick(text: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.includes(text));
  expect(button, text).toBeDefined();
  await act(async () => button!.click());
}
const submit = () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
async function edit(placeholder: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it.each(["cloud", "local", "linked"])("adds Redis with its persistent volume through the same form (%s)", async mode => {
  h.mode = mode === "cloud" ? "cloud" : "local";
  await render(mode === "linked");
  await pick("redis:7-alpine");
  await act(async () => { submit(); });
  expect(h.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ image: "redis:7-alpine", volumes: ["redis_data:/data"] }));
  expect(h.close).toHaveBeenCalledOnce();
});
it.each(["cloud", "local", "linked"])("keeps MinIO's entrypoint argv and generates credentials (%s)", async mode => {
  h.mode = mode === "cloud" ? "cloud" : "local";
  const minio = getAppTemplate("minio")!.services![0]!;
  await render(mode === "linked");
  await pick(minio.image!);
  await act(async () => { submit(); });
  expect(h.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    image: minio.image, command: "", commandArgv: ["server", "/data", "--console-address", ":9001"],
    volumes: ["minio_data:/data"],
    environment: expect.objectContaining({ MINIO_ROOT_PASSWORD: expect.stringMatching(/^[a-f0-9]{48}$/) }),
  }));
});
it("sends the GPU request of Ollama (NVIDIA GPU)", async () => {
  h.mode = "local";
  const name = "Ollama (NVIDIA GPU)";
  await render();
  await pick(name);
  await act(async () => { submit(); });
  expect(h.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    advanced: { gpus: { driver: "nvidia", count: 1, capabilities: ["gpu"] } },
  }));
});
it("sends no GPU request for plain Ollama or a replacement image", async () => {
  h.mode = "local";
  await render();
  await pick(getAppTemplate("ollama")!.services![0]!.image!);
  await act(async () => { submit(); });
  expect(h.submit.mock.calls[0]![0]).not.toHaveProperty("advanced");
});
it("does not carry a catalog GPU request onto a user-selected replacement image", async () => {
  h.mode = "local";
  await render();
  await pick("Ollama (NVIDIA GPU)");
  await edit("postgres:16-alpine", "example/other:v1");
  await act(async () => { submit(); });
  expect(h.submit.mock.calls[0]![0]).not.toHaveProperty("advanced");
});
it("does not apply catalog argv to a user-selected replacement image", async () => {
  await render();
  await pick(getAppTemplate("minio")!.services![0]!.image!);
  await edit("postgres:16-alpine", "example/custom-storage:v1");
  await act(async () => { submit(); });
  expect(h.submit.mock.calls[0]![0]).not.toHaveProperty("commandArgv");
});
it("validates a custom service name and image before submitting", async () => {
  await render();
  await pick(copy.customImage);
  // The category narrows the catalog; the remaining tile opens its form.
  const customTile = [...host.querySelectorAll<HTMLButtonElement>("button")].find(node =>
    node.title === copy.customEntryDescription);
  await act(async () => customTile!.click());
  await act(async () => { submit(); });
  expect(host.textContent).toContain(copy.serviceNameRequired);
  await edit("postgres", "my-api");
  await act(async () => { submit(); });
  expect(host.textContent).toContain(copy.imageRequired);
  expect(h.submit).not.toHaveBeenCalled();
  await edit("postgres:16-alpine", "registry.example.test/api:v2");
  await act(async () => { submit(); });
  expect(h.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: "my-api", image: "registry.example.test/api:v2" }));
});
it("retains configuration after a failed save and permits retry", async () => {
  h.submit.mockRejectedValueOnce(new Error("Server unavailable"));
  await render();
  await pick("redis:7") ;
  await act(async () => { submit(); });
  expect(host.textContent).toContain("Server unavailable");
  expect(h.close).not.toHaveBeenCalled();
  const first = h.submit.mock.calls[0]![0];
  await act(async () => { submit(); });
  expect(h.submit.mock.calls[1]![0]).toEqual(first);
  expect(h.close).toHaveBeenCalledOnce();
});
it("prevents duplicate service creation while a save is pending", async () => {
  let resolve!: () => void;
  h.submit.mockReturnValue(new Promise<void>(done => { resolve = done; }));
  await render();
  await pick("redis:7-alpine");
  await act(async () => { submit(); submit(); });
  expect(h.submit).toHaveBeenCalledOnce();
  expect(h.close).not.toHaveBeenCalled();
  await act(async () => resolve());
  expect(h.close).toHaveBeenCalledOnce();
});


it.each(["cloud", "linked"])("does not offer either self-hosted Ollama mode on managed Cloud (%s)", async mode => {
  h.mode = mode === "cloud" ? "cloud" : "local";
  await render(mode === "linked");
  expect([...host.querySelectorAll("button")].some(button => button.textContent?.includes("Ollama"))).toBe(false);
});
