import { Moon, Sun } from "lucide-react";
import { useUIStore } from "./store";

export default function ThemeToggle() {
  const themeMode = useUIStore((state) => state.themeMode);
  const toggleTheme = useUIStore((state) => state.toggleTheme);
  const isDark = themeMode === "dark";

  return <button
    type="button"
    className={`theme-switch ${isDark ? "is-dark" : ""}`}
    role="switch"
    aria-checked={isDark}
    aria-label="Dark mode"
    title={`Switch to ${isDark ? "light" : "dark"} mode`}
    onClick={toggleTheme}
  >
    <span className="theme-switch-track"><span className="theme-switch-thumb">{isDark ? <Moon size={13} /> : <Sun size={13} />}</span></span>
    <span className="theme-switch-label">{isDark ? "Dark" : "Light"}</span>
  </button>;
}
