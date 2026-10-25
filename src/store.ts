import { create } from "zustand";
import type { ViewMode } from "./types";

interface UIState {
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
}

export const useUIStore = create<UIState>((set) => ({
  viewMode: (localStorage.getItem("magazine-rack-view") as ViewMode) || "grid",
  setViewMode: (mode) => {
    localStorage.setItem("magazine-rack-view", mode);
    set({ viewMode: mode });
  },
}));
