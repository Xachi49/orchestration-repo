import { describe, expect, it, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { StatusBadge } from "./ui.js";
import { AppShell } from "../app/AppShell.js";
import {
  assertNoSecretsInBrowserStorage,
  setPrincipalId,
} from "../api/client.js";

describe("StatusBadge", () => {
  it("renders structured status text", () => {
    render(<StatusBadge status="AWAITING_ACTION" />);
    expect(screen.getByText("AWAITING_ACTION")).toBeTruthy();
  });
});

describe("Control Tower client security", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  it("D: does not persist approval nonce in browser storage", () => {
    setPrincipalId("approver_bootstrap");
    sessionStorage.setItem("orchestrator.principalId", "approver_bootstrap");
    expect(sessionStorage.getItem("decisionNonce")).toBeNull();
    expect(localStorage.getItem("decisionNonce")).toBeNull();
    assertNoSecretsInBrowserStorage();
  });

  it("I: shows development identity banner when adapter is enabled", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/health/live")) {
        return new Response(JSON.stringify({ alive: true }), { status: 200 });
      }
      if (url.includes("/health/ready")) {
        return new Response(JSON.stringify({ ready: true }), { status: 200 });
      }
      if (url.includes("/identity-mode")) {
        return new Response(
          JSON.stringify({
            authenticationMode: "HEADER_PRINCIPAL",
            runtimeEnvironment: "DEVELOPMENT",
            developmentIdentityAdapter: true,
            localDeliveryEnabled: true,
            controlTowerDevAllowAll: false,
            doctrine: {},
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    render(
      <MemoryRouter>
        <AppShell />
      </MemoryRouter>,
    );

    expect(
      await screen.findByTestId("dev-identity-banner"),
    ).toBeTruthy();
    expect(screen.getByText(/DEVELOPMENT IDENTITY MODE/i)).toBeTruthy();

    globalThis.fetch = originalFetch;
  });

  it("shows unrestricted read banner when allow-all is enabled", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/health/live")) {
        return new Response(JSON.stringify({ alive: true }), { status: 200 });
      }
      if (url.includes("/health/ready")) {
        return new Response(JSON.stringify({ ready: true }), { status: 200 });
      }
      if (url.includes("/identity-mode")) {
        return new Response(
          JSON.stringify({
            authenticationMode: "ANONYMOUS",
            runtimeEnvironment: "DEVELOPMENT",
            developmentIdentityAdapter: false,
            localDeliveryEnabled: true,
            controlTowerDevAllowAll: true,
            doctrine: {},
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    render(
      <MemoryRouter>
        <AppShell />
      </MemoryRouter>,
    );

    expect(await screen.findByTestId("dev-allow-all-banner")).toBeTruthy();
    expect(screen.getByText(/DEVELOPMENT UNRESTRICTED READ MODE/i)).toBeTruthy();

    globalThis.fetch = originalFetch;
  });
});
