/**
 * AppState — lightweight global state reducer for the Web UI.
 *
 * Keeps cross-cutting UI state in one place so that any component can read
 * connection/auth/tab state without prop drilling.
 */

export type TabId =
  | "chat" | "status" | "dashboard"
  | "events" | "skills" | "bootstrap" | "canvas" | "monitoring"
  | "plugins" | "permissions" | "cron" | "llm" | "channels" | "evolution"
  | "ops" | "cli"
  | "secrets" | "dlq" | "config-rpc" | "session-mgmt"
  | "feature-flags" | "config-migration" | "config-doctor"
  | "health-aggregator" | "message-templates" | "reply-refs" | "message-queue"
  | "channel-messages"
  | "observability" | "guardrails" | "workboard" | "steer" | "stream-view"
  | "token-usage" | "install-policy" | "transcript-redactor" | "approval-center" | "mcp-scanner"
  | "session-retention" | "voice-settings";

export type ConnectionStatus = "connecting" | "online" | "offline";

export interface AppState {
  activeTab: TabId;
  activeSessionId: string | null;
  connectionStatus: ConnectionStatus;
  authenticated: boolean;
  authChecked: boolean;
  globalError: string | null;
}

export const initialAppState: AppState = {
  activeTab: "chat",
  activeSessionId: null,
  connectionStatus: "connecting",
  authenticated: false,
  authChecked: false,
  globalError: null,
};

export type AppAction =
  | { type: "setActiveTab"; tab: TabId }
  | { type: "setActiveSession"; sessionId: string | null }
  | { type: "setConnectionStatus"; status: ConnectionStatus }
  | { type: "setAuthenticated"; authenticated: boolean }
  | { type: "setAuthChecked"; checked: boolean }
  | { type: "setGlobalError"; error: string | null }
  | { type: "clearGlobalError" };

export function appStateReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "setActiveTab":
      return { ...state, activeTab: action.tab };
    case "setActiveSession":
      return { ...state, activeSessionId: action.sessionId };
    case "setConnectionStatus":
      return { ...state, connectionStatus: action.status };
    case "setAuthenticated":
      return { ...state, authenticated: action.authenticated };
    case "setAuthChecked":
      return { ...state, authChecked: action.checked };
    case "setGlobalError":
      return { ...state, globalError: action.error };
    case "clearGlobalError":
      return { ...state, globalError: null };
    default:
      return state;
  }
}
