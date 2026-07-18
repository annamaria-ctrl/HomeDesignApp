import { LogOut } from "lucide-react";
import { useAuthStore } from "../../store/useAuthStore";

/** Pinned to the bottom of the sidebar so it's always reachable — separate from
 * ProjectActions above, which is only ever about the current project (save/open),
 * not the signed-in account. */
export function AccountMenu() {
  const user = useAuthStore((s) => s.user);
  const signOut = useAuthStore((s) => s.signOut);

  if (!user) return null;

  const initial = (user.email ?? "?").charAt(0).toUpperCase();

  return (
    <div className="border-studio-line/70 flex shrink-0 items-center gap-2 border-t px-4 py-3">
      <div className="bg-studio-clay/15 text-studio-clay-dark flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold">
        {initial}
      </div>
      <span className="text-studio-ink-soft min-w-0 flex-1 truncate text-[11px]" title={user.email ?? undefined}>
        {user.email}
      </span>
      <button
        type="button"
        onClick={() => signOut()}
        title="Sign out"
        className="text-studio-ink-soft hover:bg-studio-ink/[0.06] hover:text-studio-brick shrink-0 rounded-md p-1.5 transition-colors"
      >
        <LogOut size={14} />
      </button>
    </div>
  );
}
