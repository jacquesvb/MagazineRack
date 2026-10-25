import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { AuthError, User } from "@supabase/supabase-js";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AUTH_CALLBACK_URL, isSupabaseConfigured, supabase } from "./supabase";

type OAuthProvider = "google" | "azure";
interface AuthContextValue {
  configured: boolean;
  loading: boolean;
  user: User | null;
  recoveryMode: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, username: string) => Promise<boolean>;
  signInWithProvider: (provider: OAuthProvider) => Promise<void>;
  sendPasswordReset: (email: string) => Promise<void>;
  updatePassword: (password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function asError(error: AuthError): Error {
  return new Error(error.message);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [recoveryMode, setRecoveryMode] = useState(false);

  useEffect(() => {
    const client = supabase;
    if (!client) return;
    let active = true;
    const { data: { subscription } } = client.auth.onAuthStateChange((event, session) => {
      if (!active) return;
      setUser(session?.user || null);
      setLoading(false);
      if (event === "PASSWORD_RECOVERY") setRecoveryMode(true);
      if (event === "SIGNED_OUT") setRecoveryMode(false);
    });
    void client.auth.getSession().then(({ data }) => {
      if (active) { setUser(data.session?.user || null); setLoading(false); }
    });

    let unlisten: (() => void) | undefined;
    if (isTauri()) {
      const handleUrl = async (value: string) => {
        try {
          const callback = new URL(value);
          if (callback.protocol !== "magazinerack:" || callback.hostname !== "auth" || callback.pathname !== "/callback") return;
          const code = callback.searchParams.get("code");
          if (code) {
            const { error } = await client.auth.exchangeCodeForSession(code);
            if (error) console.error("Authentication callback failed:", error.message);
          } else {
            const params = new URLSearchParams(callback.hash.replace(/^#/, ""));
            const accessToken = params.get("access_token");
            const refreshToken = params.get("refresh_token");
            if (accessToken && refreshToken) {
              const { error } = await client.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
              if (error) console.error("Authentication callback failed:", error.message);
            }
          }
        } catch (error) { console.error("Invalid authentication callback:", error); }
      };
      void onOpenUrl((urls) => { for (const url of urls) void handleUrl(url); }).then((dispose) => {
        if (active) unlisten = dispose;
        else dispose();
      });
      void getCurrent().then((urls) => { for (const url of urls || []) void handleUrl(url); });
    }

    return () => { active = false; subscription.unsubscribe(); unlisten?.(); };
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    configured: isSupabaseConfigured,
    loading,
    user,
    recoveryMode,
    signIn: async (email, password) => {
      if (!supabase) throw new Error("Account sign-in is not configured yet.");
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw asError(error);
    },
    signUp: async (email, password, username) => {
      if (!supabase) throw new Error("Account sign-up is not configured yet.");
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(), password,
        options: { data: { username: username.trim() } },
      });
      if (error) throw asError(error);
      return Boolean(data.session);
    },
    signInWithProvider: async (provider) => {
      if (!supabase) throw new Error("Account sign-in is not configured yet.");
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo: AUTH_CALLBACK_URL,
          skipBrowserRedirect: true,
          scopes: provider === "azure" ? "email profile openid" : undefined,
        },
      });
      if (error) throw asError(error);
      if (!data.url) throw new Error("The sign-in provider did not return a login URL.");
      if (isTauri()) await openUrl(data.url);
      else window.location.assign(data.url);
    },
    sendPasswordReset: async (email) => {
      if (!supabase) throw new Error("Password recovery is not configured yet.");
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: AUTH_CALLBACK_URL });
      if (error) throw asError(error);
    },
    updatePassword: async (password) => {
      if (!supabase) throw new Error("Password recovery is not configured yet.");
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw asError(error);
      setRecoveryMode(false);
    },
    signOut: async () => {
      if (!supabase) return;
      const { error } = await supabase.auth.signOut();
      if (error) throw asError(error);
    },
  }), [loading, user, recoveryMode]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider.");
  return context;
}
