import { create } from "zustand";
import type { ViewMode } from "./types";

export type ThemeMode = "light" | "dark";

interface UIState {
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  themeMode: ThemeMode;
  toggleTheme: () => void;
}

export const useUIStore = create<UIState>((set) => ({
  viewMode: (localStorage.getItem("magazine-rack-view") as ViewMode) || "grid",
  setViewMode: (mode) => {
    localStorage.setItem("magazine-rack-view", mode);
    set({ viewMode: mode });
  },
  themeMode: localStorage.getItem("magazine-rack-theme") === "dark" ? "dark" : "light",
  toggleTheme: () => set((state) => {
    const themeMode = state.themeMode === "light" ? "dark" : "light";
    localStorage.setItem("magazine-rack-theme", themeMode);
    return { themeMode };
  }),
}));
