import { supabase } from "./supabaseClient";
import { selectPersistedDesignState } from "../store/useDesignStore";

/** The shape saved as one project's `data` blob — derived from useDesignStore's own selectPersistedDesignState so this can never drift out of sync with what actually gets persisted. */
export type PersistedDesignState = ReturnType<typeof selectPersistedDesignState>;

export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: string;
  isPublic: boolean;
}

export interface ProjectRecord extends ProjectSummary {
  data: PersistedDesignState;
}

interface ProjectRow {
  id: string;
  name: string;
  data: PersistedDesignState;
  updated_at: string;
  is_public: boolean;
}

function requireSupabase() {
  if (!supabase) throw new Error("Cloud storage is not configured.");
  return supabase;
}

function toSummary(row: Pick<ProjectRow, "id" | "name" | "updated_at" | "is_public">): ProjectSummary {
  return { id: row.id, name: row.name, updatedAt: row.updated_at, isPublic: row.is_public };
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const { data, error } = await requireSupabase()
    .from("projects")
    .select("id, name, updated_at, is_public")
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return (data as Pick<ProjectRow, "id" | "name" | "updated_at" | "is_public">[]).map(toSummary);
}

export async function getProject(id: string): Promise<ProjectRecord> {
  const { data, error } = await requireSupabase()
    .from("projects")
    .select("id, name, data, updated_at, is_public")
    .eq("id", id)
    .single();
  if (error) throw error;
  const row = data as ProjectRow;
  return { ...toSummary(row), data: row.data };
}

/**
 * Reads a project without requiring the caller to be signed in — used by the
 * public share-link viewer. Relies entirely on the "Anyone can select public
 * projects" RLS policy (is_public = true); if the project isn't public (or
 * doesn't exist), this throws exactly like getProject does for any other
 * inaccessible id, so the viewer can't distinguish "private" from "missing".
 */
export async function getPublicProject(id: string): Promise<ProjectRecord> {
  return getProject(id);
}

export async function createProject(name: string, data: PersistedDesignState): Promise<ProjectSummary> {
  const client = requireSupabase();
  const { data: userData, error: userError } = await client.auth.getUser();
  if (userError) throw userError;
  const userId = userData.user?.id;
  if (!userId) throw new Error("You're not signed in.");

  const { data: inserted, error } = await client
    .from("projects")
    .insert({ name, data, user_id: userId })
    .select("id, name, updated_at, is_public")
    .single();
  if (error) throw error;
  return toSummary(inserted as Pick<ProjectRow, "id" | "name" | "updated_at" | "is_public">);
}

// `.select().single()` after a mutation isn't just for the returned row — it's
// what turns "zero rows matched" into a thrown error. Without it, an update
// or delete that RLS silently blocks (or that targets an id that's already
// gone) reports success with no error at all, which looked exactly like a
// real save from the caller's side.

export async function updateProjectData(id: string, data: PersistedDesignState): Promise<void> {
  const { error } = await requireSupabase()
    .from("projects")
    .update({ data, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("id")
    .single();
  if (error) throw error;
}

export async function renameProject(id: string, name: string): Promise<void> {
  const { error } = await requireSupabase().from("projects").update({ name }).eq("id", id).select("id").single();
  if (error) throw error;
}

export async function setProjectPublic(id: string, isPublic: boolean): Promise<void> {
  const { error } = await requireSupabase()
    .from("projects")
    .update({ is_public: isPublic })
    .eq("id", id)
    .select("id")
    .single();
  if (error) throw error;
}

export async function deleteProject(id: string): Promise<void> {
  const { error } = await requireSupabase().from("projects").delete().eq("id", id).select("id").single();
  if (error) throw error;
}
