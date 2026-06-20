/**
 * AppStateContext — global React context for the Web UI.
 *
 * Wrap the app with <AppStateProvider> and consume state with useAppState().
 */

import React, { createContext, useContext, useReducer, useMemo, type ReactNode } from "react";
import { appStateReducer, initialAppState, type AppState, type AppAction } from "./app-state.ts";

interface AppStateContextValue {
  state: AppState;
  dispatch: React.Dispatch<AppAction>;
}

const AppStateContext = createContext<AppStateContextValue | null>(null);

export function AppStateProvider({ children, initialState }: { children: ReactNode; initialState?: Partial<AppState> }) {
  const [state, dispatch] = useReducer(appStateReducer, { ...initialAppState, ...initialState });
  const value = useMemo(() => ({ state, dispatch }), [state, dispatch]);
  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState(): AppStateContextValue {
  const ctx = useContext(AppStateContext);
  if (!ctx) {
    throw new Error("useAppState must be used within <AppStateProvider>");
  }
  return ctx;
}
