import { useState } from "react";
import { Pencil, Trash2, Globe, Lock, ExternalLink, Copy, Check } from "lucide-react";
import type { ProjectSummary } from "../../lib/cloudProjects";

interface ProjectListItemProps {
  project: ProjectSummary;
  isCurrent: boolean;
  shareUrl: string;
  onLoad: () => void;
  onRename: (name: string) => void;
  onTogglePublic: (isPublic: boolean) => void;
  onDelete: () => void;
}

const pillClass =
  "flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium transition-colors";

/** One row in the saved-projects list: open, rename in place, and — once marked public — open or copy its view-only link, all without first having to load that project. */
export function ProjectListItem({ project, isCurrent, shareUrl, onLoad, onRename, onTogglePublic, onDelete }: ProjectListItemProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(project.name);
  const [linkCopied, setLinkCopied] = useState(false);

  function startEditing() {
    setDraft(project.name);
    setEditing(true);
  }

  function commitRename() {
    setEditing(false);
    if (draft.trim() && draft.trim() !== project.name) onRename(draft);
  }

  async function handleCopyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      prompt("Copy this link:", shareUrl);
    }
  }

  return (
    <li
      className={`rounded-lg p-2 transition-colors ${
        isCurrent ? "bg-studio-clay/[0.07] ring-studio-clay/25 ring-1" : "hover:bg-studio-ink/[0.035]"
      }`}
    >
      <div className="flex items-center gap-1">
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") setEditing(false);
            }}
            className="border-studio-clay/50 bg-studio-paper min-w-0 flex-1 rounded-md border px-1.5 py-1 text-[12.5px] font-medium outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={onLoad}
            title="Open this project"
            className={`min-w-0 flex-1 truncate text-left text-[12.5px] ${
              isCurrent ? "text-studio-clay-dark font-semibold" : "text-studio-ink font-medium"
            }`}
          >
            {project.name}
          </button>
        )}
        {isCurrent && !editing && (
          <span className="bg-studio-clay/15 text-studio-clay-dark shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide">
            Open
          </span>
        )}
        <div className="flex shrink-0 items-center gap-0.5">
          {!editing && (
            <button
              type="button"
              onClick={startEditing}
              title="Rename"
              className="text-studio-ink-faint hover:bg-studio-ink/[0.07] hover:text-studio-ink flex h-6 w-6 items-center justify-center rounded-md transition-colors"
            >
              <Pencil size={12} />
            </button>
          )}
          <button
            type="button"
            onClick={onDelete}
            title="Delete"
            className="text-studio-ink-faint hover:bg-studio-brick/10 hover:text-studio-brick flex h-6 w-6 items-center justify-center rounded-md transition-colors"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-1 pl-0.5">
        <button
          type="button"
          onClick={() => onTogglePublic(!project.isPublic)}
          title={project.isPublic ? "Turn off the public link" : "Create a public view-only link"}
          className={`${pillClass} ${
            project.isPublic
              ? "bg-studio-clay/10 text-studio-clay-dark hover:bg-studio-clay/15"
              : "bg-studio-ink/[0.05] text-studio-ink-soft hover:bg-studio-ink/[0.08]"
          }`}
        >
          {project.isPublic ? <Globe size={10} /> : <Lock size={10} />}
          {project.isPublic ? "Public" : "Private"}
        </button>
        {project.isPublic && (
          <>
            <a
              href={shareUrl}
              target="_blank"
              rel="noreferrer"
              title="Open the public view-only page"
              className={`${pillClass} text-studio-ink-soft hover:bg-studio-ink/[0.07] hover:text-studio-ink`}
            >
              <ExternalLink size={10} /> Open link
            </a>
            <button
              type="button"
              onClick={handleCopyLink}
              title="Copy the public link"
              className={`${pillClass} text-studio-ink-soft hover:bg-studio-ink/[0.07] hover:text-studio-ink`}
            >
              {linkCopied ? <Check size={10} /> : <Copy size={10} />}
              {linkCopied ? "Copied" : "Copy link"}
            </button>
          </>
        )}
      </div>
    </li>
  );
}
