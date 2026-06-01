"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type ModuleSummary = {
  id: string;
  name: string;
  description: string;
  core: boolean;
  navUrl: string | null;
  navTitle: string | null;
  enabled: boolean;
  enabledAt: string | null;
  disabledAt: string | null;
  enabledByName: string | null;
  disabledByName: string | null;
  updatedAt: string | null;
};

type ModulesState = {
  ready: boolean;
  modules: ModuleSummary[];
  enabledIds: Set<string>;
};

type Ctx = ModulesState & {
  isEnabled: (id: string) => boolean;
  reload: () => Promise<void>;
};

const ModulesContext = createContext<Ctx | null>(null);

export function ModulesProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ModulesState>({
    ready: false,
    modules: [],
    // Optimistic default: assume everything is enabled until the GET resolves
    // (matches the seed behavior on first boot). Prevents UI flash during load.
    enabledIds: new Set(["kanban", "agenda", "processes", "documents", "system"]),
  });

  // We re-fetch when the window regains focus so a toggle in another tab
  // reflects without a manual refresh.
  const fetchingRef = useRef(false);

  const load = useCallback(async () => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    try {
      const res = await fetch("/api/modules", { cache: "reload" });
      if (!res.ok) return;
      const json = await res.json();
      if (!json.ok) return;
      const modules = (json.modules || []) as ModuleSummary[];
      const enabledIds = new Set<string>((json.enabledIds || []) as string[]);
      setState({ ready: true, modules, enabledIds });
    } finally {
      fetchingRef.current = false;
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  const value = useMemo<Ctx>(
    () => ({
      ...state,
      isEnabled: (id: string) => state.enabledIds.has(id),
      reload: load,
    }),
    [state, load],
  );

  return <ModulesContext.Provider value={value}>{children}</ModulesContext.Provider>;
}

export function useModules(): Ctx {
  const ctx = useContext(ModulesContext);
  if (!ctx) {
    // Defensive fallback so a component used outside the provider still works
    // (e.g. tests). Returns optimistic-all-enabled.
    return {
      ready: false,
      modules: [],
      enabledIds: new Set(["kanban", "agenda", "processes", "documents", "system"]),
      isEnabled: () => true,
      reload: async () => {},
    };
  }
  return ctx;
}
