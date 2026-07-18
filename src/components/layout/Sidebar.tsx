import { useState } from "react";
import { Wrench, Sofa, LayoutGrid } from "lucide-react";
import { ToolPanel } from "../sidebar/ToolPanel";
import { ElementLibrary } from "../sidebar/ElementLibrary";
import { FurnitureThumbnailFactory } from "../sidebar/FurnitureThumbnailFactory";
import { ProjectActions } from "./ProjectActions";
import { UndoRedoControls } from "./UndoRedoControls";
import { AccountMenu } from "./AccountMenu";

type TabId = "tools" | "library";

const TABS: { id: TabId; label: string; icon: typeof Wrench }[] = [
  { id: "tools", label: "Tools", icon: Wrench },
  { id: "library", label: "Furniture", icon: Sofa },
];

export function Sidebar() {
  const [activeTab, setActiveTab] = useState<TabId>("tools");

  return (
    <aside className="border-studio-line/70 bg-studio-paper/80 relative flex h-full w-80 shrink-0 flex-col border-r backdrop-blur-xl">
      <div className="border-studio-line/70 flex items-center gap-2.5 border-b px-4 py-4">
        <div className="from-studio-clay-light to-studio-clay relative flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-gradient-to-br text-white shadow-[0_4px_14px_-3px_rgba(171,90,56,0.55)]">
          <LayoutGrid size={16} strokeWidth={2.25} />
        </div>
        <div className="min-w-0">
          <div className="font-serif text-studio-ink text-[15px] font-medium tracking-tight">Home Design</div>
          <div className="text-studio-ink-soft text-[10.5px] font-medium">Interior Planner</div>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <UndoRedoControls />
          <ProjectActions />
        </div>
      </div>

      <div className="flex gap-1 px-3 pt-3">
        {TABS.map(({ id, label, icon: Icon }) => {
          const isActive = activeTab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setActiveTab(id)}
              className={`relative flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[12px] font-medium transition-all duration-150 ${
                isActive
                  ? "bg-studio-paper-alt text-studio-clay-dark shadow-[inset_0_1px_0_rgba(255,255,255,0.5)]"
                  : "text-studio-ink-soft hover:bg-studio-ink/[0.03] hover:text-studio-ink"
              }`}
            >
              <Icon size={14} strokeWidth={isActive ? 2.25 : 2} />
              {label}
              {isActive && (
                <span className="via-studio-clay absolute inset-x-3 -bottom-[1px] h-px bg-gradient-to-r from-transparent to-transparent" />
              )}
            </button>
          );
        })}
      </div>
      <div className="border-studio-line/70 mx-3 mt-3 border-b" />

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {activeTab === "tools" && <ToolPanel />}
        {activeTab === "library" && <ElementLibrary />}
      </div>

      <AccountMenu />
      <FurnitureThumbnailFactory />
    </aside>
  );
}
