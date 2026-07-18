import { create } from "zustand";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "../lib/supabaseClient";

interface AuthState {
  session: Session | null;
  user: User | null;
  /** "loading" only while the initial session restore is in flight, right after init() is called. */
  status: "loading" | "signedOut" | "signedIn";
  pending: boolean;
  error: string | null;
  initialized: boolean;
  init: () => void;
  signInWithPassword: (email: string, password: string) => Promise<boolean>;
  signUpWithPassword: (email: string, password: string) => Promise<boolean>;
  signOut: () => Promise<void>;
  clearError: () => void;
}

function friendlyAuthError(message: string): string {
  if (message.includes("Invalid login credentials")) return "Incorrect email or password.";
  if (message.includes("User already registered")) return "This email is already registered — try signing in instead.";
  if (message.includes("Password should be at least")) return "Password must be at least 6 characters.";
  if (message.includes("Unable to validate email")) return "Invalid email format.";
  return message;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  session: null,
  user: null,
  status: "loading",
  pending: false,
  error: null,
  initialized: false,

  init: () => {
    if (get().initialized || !supabase) return;
    set({ initialized: true });
    supabase.auth.getSession().then(({ data }) => {
      set({
        session: data.session,
        user: data.session?.user ?? null,
        status: data.session ? "signedIn" : "signedOut",
      });
    });
    supabase.auth.onAuthStateChange((_event, session) => {
      set({ session, user: session?.user ?? null, status: session ? "signedIn" : "signedOut" });
    });
  },

  signInWithPassword: async (email, password) => {
    if (!supabase) return false;
    set({ pending: true, error: null });
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    set({ pending: false, error: error ? friendlyAuthError(error.message) : null });
    return !error;
  },

  signUpWithPassword: async (email, password) => {
    if (!supabase) return false;
    set({ pending: true, error: null });
    const { error } = await supabase.auth.signUp({ email, password });
    set({ pending: false, error: error ? friendlyAuthError(error.message) : null });
    return !error;
  },

  signOut: async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
  },

  clearError: () => set({ error: null }),
}));
