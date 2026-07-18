import { useState, type FormEvent, type ReactNode } from "react";
import { LayoutGrid, Loader2 } from "lucide-react";
import { useAuthStore } from "../../store/useAuthStore";
import { isSupabaseConfigured } from "../../lib/supabaseClient";

/** Gates the whole app behind Supabase auth: shows a sign-in/sign-up screen until a session exists, then renders children. */
export function AuthGate({ children }: { children: ReactNode }) {
  const status = useAuthStore((s) => s.status);

  if (!isSupabaseConfigured) {
    return (
      <div className="app-shell-bg text-studio-ink flex h-screen w-screen items-center justify-center p-6">
        <div className="border-studio-line bg-studio-paper max-w-md rounded-2xl border p-6 text-center shadow-lg">
          <div className="font-serif text-lg font-medium">Cloud storage isn't set up</div>
          <p className="text-studio-ink-soft mt-2 text-sm">
            Missing <code className="bg-studio-ink/[0.06] rounded px-1 py-0.5">VITE_SUPABASE_URL</code> and{" "}
            <code className="bg-studio-ink/[0.06] rounded px-1 py-0.5">VITE_SUPABASE_ANON_KEY</code>. Set them in{" "}
            <code className="bg-studio-ink/[0.06] rounded px-1 py-0.5">.env</code> (locally) or in your deployment's
            environment variables (Vercel).
          </p>
        </div>
      </div>
    );
  }

  if (status === "loading") {
    return (
      <div className="app-shell-bg flex h-screen w-screen items-center justify-center">
        <Loader2 size={22} className="text-studio-clay animate-spin" />
      </div>
    );
  }

  if (status === "signedOut") return <AuthScreen />;

  return <>{children}</>;
}

function AuthScreen() {
  const [mode, setMode] = useState<"signIn" | "signUp">("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [justSignedUp, setJustSignedUp] = useState(false);
  const signInWithPassword = useAuthStore((s) => s.signInWithPassword);
  const signUpWithPassword = useAuthStore((s) => s.signUpWithPassword);
  const pending = useAuthStore((s) => s.pending);
  const error = useAuthStore((s) => s.error);
  const clearError = useAuthStore((s) => s.clearError);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setJustSignedUp(false);
    if (mode === "signIn") {
      await signInWithPassword(email, password);
    } else {
      const ok = await signUpWithPassword(email, password);
      if (ok) setJustSignedUp(true);
    }
  }

  return (
    <div className="app-shell-bg text-studio-ink flex h-screen w-screen items-center justify-center p-6">
      <div className="border-studio-line bg-studio-paper w-full max-w-sm rounded-2xl border p-7 shadow-[0_20px_50px_-20px_rgba(43,36,28,0.35)]">
        <div className="mb-6 flex items-center gap-2.5">
          <div className="from-studio-clay-light to-studio-clay flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-gradient-to-br text-white shadow-[0_4px_14px_-3px_rgba(171,90,56,0.55)]">
            <LayoutGrid size={17} strokeWidth={2.25} />
          </div>
          <div>
            <div className="font-serif text-studio-ink text-[16px] font-medium tracking-tight">Home Design</div>
            <div className="text-studio-ink-soft text-[10.5px] font-medium">Interior Planner</div>
          </div>
        </div>

        <div className="border-studio-line mb-5 flex rounded-lg border p-0.5 text-sm">
          <button
            type="button"
            onClick={() => {
              setMode("signIn");
              clearError();
            }}
            className={`flex-1 rounded-md py-1.5 font-medium transition-colors ${
              mode === "signIn" ? "bg-studio-clay text-white" : "text-studio-ink-soft"
            }`}
          >
            Sign in
          </button>
          <button
            type="button"
            onClick={() => {
              setMode("signUp");
              clearError();
            }}
            className={`flex-1 rounded-md py-1.5 font-medium transition-colors ${
              mode === "signUp" ? "bg-studio-clay text-white" : "text-studio-ink-soft"
            }`}
          >
            Sign up
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-studio-ink-soft text-xs font-medium">Email</span>
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="border-studio-line bg-studio-bg/60 focus:border-studio-clay/60 rounded-md border px-3 py-2 text-sm outline-none transition-colors"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-studio-ink-soft text-xs font-medium">Password</span>
            <input
              type="password"
              required
              minLength={6}
              autoComplete={mode === "signIn" ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="border-studio-line bg-studio-bg/60 focus:border-studio-clay/60 rounded-md border px-3 py-2 text-sm outline-none transition-colors"
            />
          </label>

          {error && <div className="bg-studio-brick/10 text-studio-brick rounded-md px-3 py-2 text-xs">{error}</div>}
          {justSignedUp && !error && (
            <div className="rounded-md bg-emerald-600/10 px-3 py-2 text-xs text-emerald-700">
              Account created. If confirmation is required, check your email — otherwise you'll be signed in automatically in
              a moment.
            </div>
          )}

          <button
            type="submit"
            disabled={pending}
            className="bg-studio-clay hover:bg-studio-clay-dark mt-1 flex items-center justify-center gap-2 rounded-md py-2 text-sm font-medium text-white transition-colors disabled:opacity-60"
          >
            {pending && <Loader2 size={14} className="animate-spin" />}
            {mode === "signIn" ? "Sign in" : "Create account"}
          </button>
        </form>
      </div>
    </div>
  );
}
