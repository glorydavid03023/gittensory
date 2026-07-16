import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// #6177: StateBoundary's errorLabel prop (global failure toast via notifyApiFailure) has always worked and been
// tested (state-views.test.tsx), but no real panel ever passed it -- so a dashboard data-fetch failure never
// produced the toast this feature exists for. These tests pin the wiring: each panel's StateBoundary must now
// forward a real, panel-specific label to notifyApiFailure on error.
const { notifyApiFailure } = vi.hoisted(() => ({ notifyApiFailure: vi.fn() }));
vi.mock("@/lib/api/request", () => ({
  notifyApiFailure: (...args: unknown[]) => notifyApiFailure(...args),
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

const { useApiResource } = vi.hoisted(() => ({ useApiResource: vi.fn() }));
vi.mock("@/lib/api/use-api-resource", () => ({ useApiResource: () => useApiResource() }));

import { CommandsPanel } from "@/components/site/app-panels/commands-panel";
import { DigestPanel } from "@/components/site/app-panels/digest-panel";
import { OwnerPanel } from "@/components/site/app-panels/owner-panel";

function errorState() {
  return {
    status: "error",
    data: null,
    error: "boom",
    errorKind: "http",
    loadedAt: null,
    reload: () => {},
  };
}

const PANELS = [
  { name: "DigestPanel", label: "Maintainer digest", render: () => render(<DigestPanel />) },
  { name: "CommandsPanel", label: "Command simulator", render: () => render(<CommandsPanel />) },
  { name: "OwnerPanel", label: "Repo owner workspace", render: () => render(<OwnerPanel />) },
] as const;

describe("StateBoundary errorLabel forwarding (#6177)", () => {
  for (const panel of PANELS) {
    it(`${panel.name} surfaces its own errorLabel to the failure notifier on error`, () => {
      useApiResource.mockReturnValue(errorState());
      panel.render();
      expect(notifyApiFailure).toHaveBeenCalledWith(
        expect.objectContaining({ label: panel.label }),
      );
    });
  }
});
