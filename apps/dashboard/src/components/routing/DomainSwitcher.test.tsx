// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { DomainSwitcher } from "./DomainSwitcher";

it("lists complete hostnames and selects a different domain", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const domains = [
    "pb-staging.op.dev.kahuna.adetify.com",
    "api-staging.op.dev.kahuna.adetify.com",
    "admin.edge.example.com",
  ];
  const onChange = vi.fn();
  try {
    await act(async () => root.render(
      <I18nProvider>
        <DomainSwitcher domains={domains} value={domains[0]!} onChange={onChange} />
      </I18nProvider>,
    ));
    const trigger = host.querySelector<HTMLButtonElement>("button")!;
    await act(async () => trigger.click());
    const choices = [...host.querySelectorAll<HTMLButtonElement>("button")].slice(1);
    expect(choices.map((choice) => choice.textContent)).toEqual(domains);
    await act(async () => choices[1]!.click());
    expect(onChange).toHaveBeenCalledExactlyOnceWith(domains[1]);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
