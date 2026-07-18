import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isSupabaseConfigured = Boolean(url && anonKey);

/**
 * Missing env vars shouldn't crash the whole app at import time (Vite
 * evaluates this module eagerly) — callers check isSupabaseConfigured and
 * show a setup message instead, so a misconfigured deploy fails obviously
 * in the UI rather than with a blank white screen.
 */
export const supabase = isSupabaseConfigured ? createClient(url!, anonKey!) : null;
