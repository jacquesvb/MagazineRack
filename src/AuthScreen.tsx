import { useState, type FormEvent } from "react";
import { ArrowLeft, BookOpen, LoaderCircle, LockKeyhole, Mail, ShieldCheck, UserRound } from "lucide-react";
import { useAuth } from "./auth";
import ThemeToggle from "./ThemeToggle";

type Mode = "sign-in" | "sign-up" | "forgot-password";

export default function AuthScreen() {
  const auth = useAuth();
  const [mode, setMode] = useState<Mode>("sign-in");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(""); setNotice("");
    try { await action(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Something went wrong. Please try again."); }
    finally { setBusy(false); }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (auth.recoveryMode) {
      if (password.length < 8) { setError("Use at least 8 characters for your new password."); return; }
      if (password !== confirmPassword) { setError("The passwords do not match."); return; }
      await run(async () => { await auth.updatePassword(password); setPassword(""); setConfirmPassword(""); setNotice("Your password has been updated."); });
      return;
    }
    if (mode === "forgot-password") {
      await run(async () => { await auth.sendPasswordReset(email); setNotice("If an account exists for this email, a password reset link is on its way."); });
      return;
    }
    if (mode === "sign-up") {
      if (password.length < 8) { setError("Use at least 8 characters for your password."); return; }
      await run(async () => {
        const hasSession = await auth.signUp(email, password, username);
        if (!hasSession) setNotice("Check your email to confirm your account, then sign in.");
      });
      return;
    }
    await run(() => auth.signIn(email, password));
  };

  const title = auth.recoveryMode ? "Choose a new password" : mode === "sign-up" ? "Create your account" : mode === "forgot-password" ? "Reset your password" : "Welcome back";
  const subtitle = auth.recoveryMode ? "Choose a new password for your Magazine Rack account." : mode === "sign-up" ? "Your personal reading room, synced across devices." : mode === "forgot-password" ? "We’ll email you a secure password reset link." : "Sign in to pick up where you left off.";

  return <main className="auth-screen">
    <section className="auth-card">
      <div className="auth-topline"><div className="auth-brand"><div className="brand-mark"><BookOpen size={19} /></div><span>MAGAZINE RACK</span></div><ThemeToggle /></div>
      <div className="auth-heading"><h1>{title}</h1><p>{subtitle}</p></div>

      {!auth.recoveryMode && mode === "sign-in" && <div className="oauth-options">
        <button className="oauth-button" disabled={busy} onClick={() => void run(() => auth.signInWithProvider("google"))}><GoogleMark /> Continue with Google</button>
        <button className="oauth-button" disabled={busy} onClick={() => void run(() => auth.signInWithProvider("azure"))}><MicrosoftMark /> Continue with Microsoft</button>
      </div>}
      {!auth.recoveryMode && mode === "sign-in" && <div className="auth-divider"><span>or continue with email</span></div>}

      <form className="auth-form" onSubmit={(event) => void submit(event)}>
        {mode === "sign-up" && !auth.recoveryMode && <label className="field"><span>Username</span><div className="auth-input"><UserRound size={16} /><input autoComplete="nickname" value={username} onChange={(event) => setUsername(event.target.value)} required minLength={2} maxLength={32} placeholder="How should we address you?" /></div></label>}
        <label className="field"><span>Email address</span><div className="auth-input"><Mail size={16} /><input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required placeholder="you@example.com" /></div></label>
        {mode !== "forgot-password" && <label className="field"><span>{auth.recoveryMode ? "New password" : "Password"}</span><div className="auth-input"><LockKeyhole size={16} /><input type="password" autoComplete={auth.recoveryMode ? "new-password" : mode === "sign-up" ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} required minLength={8} placeholder="At least 8 characters" /></div></label>}
        {auth.recoveryMode && <label className="field"><span>Confirm new password</span><div className="auth-input"><LockKeyhole size={16} /><input type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required minLength={8} placeholder="Enter it again" /></div></label>}
        {mode === "sign-in" && !auth.recoveryMode && <button type="button" className="auth-forgot" onClick={() => { setMode("forgot-password"); setError(""); setNotice(""); }}>Forgot password?</button>}
        {error && <div className="auth-feedback auth-error" role="alert">{error}</div>}
        {notice && <div className="auth-feedback auth-notice" role="status"><ShieldCheck size={16} />{notice}</div>}
        <button className="button button-primary auth-submit" disabled={busy}>{busy && <LoaderCircle size={16} className="spin" />}{auth.recoveryMode ? "Update password" : mode === "sign-up" ? "Create account" : mode === "forgot-password" ? "Send reset link" : "Sign in"}</button>
      </form>

      <div className="auth-switch">
        {auth.recoveryMode || mode === "forgot-password" ? <button onClick={() => { if (auth.recoveryMode) void auth.signOut().catch((reason) => setError(reason instanceof Error ? reason.message : "Could not exit password reset.")); setMode("sign-in"); setError(""); setNotice(""); }}><ArrowLeft size={14} /> Back to sign in</button> : mode === "sign-in" ? <span>New to Magazine Rack? <button onClick={() => { setMode("sign-up"); setError(""); setNotice(""); }}>Create an account</button></span> : <span>Already have an account? <button onClick={() => { setMode("sign-in"); setError(""); setNotice(""); }}>Sign in</button></span>}
      </div>
      <p className="auth-privacy">Your catalog is private to your account. Downloaded PDFs remain on each device.</p>
    </section>
  </main>;
}

function GoogleMark() {
  return <svg aria-hidden="true" viewBox="0 0 18 18" width="17" height="17"><path fill="#4285F4" d="M17.64 9.2c0-.57-.05-1.12-.15-1.65H9v3.12h4.84a4.14 4.14 0 0 1-1.8 2.72v2.25h2.91c1.7-1.57 2.69-3.88 2.69-6.44Z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.17l-2.91-2.25c-.8.54-1.83.87-3.05.87-2.35 0-4.35-1.59-5.06-3.73H.94v2.32A9 9 0 0 0 9 18Z"/><path fill="#FBBC05" d="M3.94 10.72A5.41 5.41 0 0 1 3.66 9c0-.6.1-1.18.28-1.72V4.96H.94A9 9 0 0 0 0 9c0 1.45.35 2.82.94 4.04l3-2.32Z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.46 3.43 1.36L15 2.37C13.46.94 11.43 0 9 0A9 9 0 0 0 .94 4.96l3 2.32C4.65 5.17 6.65 3.58 9 3.58Z"/></svg>;
}

function MicrosoftMark() {
  return <svg aria-hidden="true" viewBox="0 0 18 18" width="16" height="16"><path fill="#f25022" d="M1 1h7.2v7.2H1z"/><path fill="#7fba00" d="M9.8 1H17v7.2H9.8z"/><path fill="#00a4ef" d="M1 9.8h7.2V17H1z"/><path fill="#ffb900" d="M9.8 9.8H17V17H9.8z"/></svg>;
}
