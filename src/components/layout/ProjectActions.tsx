import { useEffect, useRef, useState } from "react";
import { FolderOpen, Save, Plus, Loader2, Check, ChevronDown, FileDown, FileUp } from "lucide-react";
import { useDesignStore } from "../../store/useDesignStore";
import { useProjectStore } from "../../store/useProjectStore";
import { serializeProject, parseProjectFile, downloadTextFile } from "../../lib/projectFile";
import { ProjectListItem } from "./ProjectListItem";

export function ProjectActions() {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const currentProjectName = useProjectStore((s) => s.currentProjectName);
  const projects = useProjectStore((s) => s.projects);
  const listStatus = useProjectStore((s) => s.listStatus);
  const saveStatus = useProjectStore((s) => s.saveStatus);
  const saveError = useProjectStore((s) => s.saveError);
  const actionError = useProjectStore((s) => s.actionError);
  const refreshProjects = useProjectStore((s) => s.refreshProjects);
  const loadProject = useProjectStore((s) => s.loadProject);
  const saveCurrentProject = useProjectStore((s) => s.saveCurrentProject);
  const saveAsNewProject = useProjectStore((s) => s.saveAsNewProject);
  const renameCurrentProject = useProjectStore((s) => s.renameCurrentProject);
  const renameProject = useProjectStore((s) => s.renameProject);
  const deleteProject = useProjectStore((s) => s.deleteProject);
  const startNewProject = useProjectStore((s) => s.startNewProject);
  const setProjectPublic = useProjectStore((s) => s.setProjectPublic);

  const [nameDraft, setNameDraft] = useState(currentProjectName);
  useEffect(() => setNameDraft(currentProjectName), [currentProjectName]);

  useEffect(() => {
    if (open) refreshProjects();
  }, [open, refreshProjects]);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  // local-file backup/restore, kept as a secondary option alongside cloud save
  const walls = useDesignStore((s) => s.walls);
  const openings = useDesignStore((s) => s.openings);
  const furniture = useDesignStore((s) => s.furniture);
  const rooms = useDesignStore((s) => s.rooms);
  const roomFloors = useDesignStore((s) => s.roomFloors);
  const measurements = useDesignStore((s) => s.measurements);
  const lastWallThickness = useDesignStore((s) => s.lastWallThickness);
  const gridSizeM = useDesignStore((s) => s.gridSizeM);
  const showOverallDimensions = useDesignStore((s) => s.showOverallDimensions);
  const showCeiling = useDesignStore((s) => s.showCeiling);
  const loadDesign = useDesignStore((s) => s.loadDesign);
  const pushHistory = useDesignStore((s) => s.pushHistory);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  function handleDownloadBackup() {
    const json = serializeProject({
      walls,
      openings,
      furniture,
      rooms,
      roomFloors,
      measurements,
      lastWallThickness,
      gridSizeM,
      showOverallDimensions,
      showCeiling,
    });
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    downloadTextFile(`${currentProjectName || "project"}-${stamp}.json`, json);
  }

  function shareUrl(id: string) {
    return `${window.location.origin}${window.location.pathname}?view=${id}`;
  }

  async function handleUploadBackup(file: File | undefined) {
    if (!file) return;
    try {
      const text = await file.text();
      pushHistory();
      loadDesign(parseProjectFile(text));
      setFileError(null);
    } catch {
      setFileError("The file couldn't be loaded.");
      setTimeout(() => setFileError(null), 4000);
    }
  }

  return (
    <div className="relative" ref={panelRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Projects"
        className={`flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors ${
          open ? "bg-studio-ink/[0.06] text-studio-ink" : "text-studio-ink-soft hover:bg-studio-ink/[0.06] hover:text-studio-ink"
        }`}
      >
        <FolderOpen size={15} />
        <span className="max-w-28 truncate">{currentProjectName}</span>
        <ChevronDown size={12} className={`transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="border-studio-line bg-studio-paper absolute right-0 top-full z-30 mt-2 w-72 overflow-hidden rounded-xl border shadow-[0_20px_50px_-20px_rgba(43,36,28,0.45)]">
          <div className="p-3">
            <div className="text-studio-ink-faint mb-1.5 text-[10px] font-semibold uppercase tracking-wider">Current project</div>
            <input
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={() => nameDraft.trim() !== currentProjectName && renameCurrentProject(nameDraft)}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
              className="border-studio-line bg-studio-bg/50 focus:border-studio-clay/60 focus:bg-studio-paper font-serif text-studio-ink mb-2.5 w-full rounded-md border px-2.5 py-1.5 text-[13px] font-medium outline-none transition-colors"
            />

            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={saveCurrentProject}
                disabled={saveStatus === "saving"}
                className="bg-studio-clay hover:bg-studio-clay-dark flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md text-xs font-medium text-white transition-colors disabled:opacity-60"
              >
                {saveStatus === "saving" ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : saveStatus === "saved" ? (
                  <Check size={13} />
                ) : (
                  <Save size={13} />
                )}
                {currentProjectId ? "Save" : "Save to cloud"}
              </button>
              <button
                type="button"
                onClick={() => saveAsNewProject(`${currentProjectName} (copy)`)}
                title="Save as new project"
                className="border-studio-line text-studio-ink-soft hover:bg-studio-ink/[0.05] flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors"
              >
                <Plus size={14} />
              </button>
            </div>
            {saveError && (
              <div className="bg-studio-brick/10 text-studio-brick mt-2 rounded-md px-2 py-1 text-[11px]">{saveError}</div>
            )}
          </div>

          <div className="border-studio-line border-t p-3 py-2">
            <button
              type="button"
              onClick={startNewProject}
              className="text-studio-ink-soft hover:bg-studio-ink/[0.05] hover:text-studio-ink flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors"
            >
              <Plus size={13} /> New (blank) project
            </button>
          </div>

          <div className="border-studio-line border-t p-3">
            <div className="mb-1.5 flex items-baseline justify-between gap-2 px-1">
              <span className="text-studio-ink-faint text-[10px] font-semibold uppercase tracking-wider">Saved projects</span>
              {projects.length > 0 && (
                <span className="text-studio-ink-faint text-[10px]">Open · rename · share</span>
              )}
            </div>
            {listStatus === "loading" && (
              <div className="text-studio-ink-soft flex items-center gap-1.5 px-1 py-1.5 text-xs">
                <Loader2 size={12} className="animate-spin" /> Loading…
              </div>
            )}
            {listStatus === "idle" && projects.length === 0 && (
              <div className="text-studio-ink-faint px-1 py-1.5 text-xs">No saved projects yet.</div>
            )}
            <ul className="max-h-64 space-y-1 overflow-y-auto">
              {projects.map((p) => (
                <ProjectListItem
                  key={p.id}
                  project={p}
                  isCurrent={p.id === currentProjectId}
                  shareUrl={shareUrl(p.id)}
                  onLoad={() => loadProject(p.id)}
                  onRename={(name) => renameProject(p.id, name)}
                  onTogglePublic={(isPublic) => setProjectPublic(p.id, isPublic)}
                  onDelete={() => {
                    if (confirm(`Delete project "${p.name}"?`)) deleteProject(p.id);
                  }}
                />
              ))}
            </ul>
            {actionError && (
              <div className="bg-studio-brick/10 text-studio-brick mt-1.5 rounded-md px-2 py-1 text-[11px]">{actionError}</div>
            )}
          </div>

          <div className="border-studio-line border-t p-3 pt-2">
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={handleDownloadBackup}
                title="Download backup (.json)"
                className="text-studio-ink-soft hover:bg-studio-ink/[0.05] hover:text-studio-ink flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-[11px] font-medium transition-colors"
              >
                <FileDown size={13} /> Backup
              </button>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                title="Restore from backup (.json)"
                className="text-studio-ink-soft hover:bg-studio-ink/[0.05] hover:text-studio-ink flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-[11px] font-medium transition-colors"
              >
                <FileUp size={13} /> Restore
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json"
                className="hidden"
                onChange={(e) => {
                  handleUploadBackup(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </div>
            {fileError && (
              <div className="bg-studio-brick/10 text-studio-brick mt-2 rounded-md px-2 py-1 text-[11px]">{fileError}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
