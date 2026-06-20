import { describe, it, expect } from "vitest";
import { appStateReducer, initialAppState } from "./app-state.ts";

describe("appStateReducer", () => {
  it("should set active tab", () => {
    const state = appStateReducer(initialAppState, { type: "setActiveTab", tab: "status" });
    expect(state.activeTab).toBe("status");
  });

  it("should set active session", () => {
    const state = appStateReducer(initialAppState, { type: "setActiveSession", sessionId: "sess-123" });
    expect(state.activeSessionId).toBe("sess-123");
  });

  it("should set connection status", () => {
    const state = appStateReducer(initialAppState, { type: "setConnectionStatus", status: "offline" });
    expect(state.connectionStatus).toBe("offline");
  });

  it("should set authenticated and auth checked", () => {
    let state = appStateReducer(initialAppState, { type: "setAuthenticated", authenticated: true });
    expect(state.authenticated).toBe(true);
    state = appStateReducer(state, { type: "setAuthChecked", checked: true });
    expect(state.authChecked).toBe(true);
  });

  it("should set and clear global error", () => {
    let state = appStateReducer(initialAppState, { type: "setGlobalError", error: "Something failed" });
    expect(state.globalError).toBe("Something failed");
    state = appStateReducer(state, { type: "clearGlobalError" });
    expect(state.globalError).toBeNull();
  });
});
