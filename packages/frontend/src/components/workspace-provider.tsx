import { createContext, use, useState } from 'react';

import { trpc } from '../lib/trpc';

import type { ReactNode } from 'react';

interface WorkspaceItem {
  id: string;
  name: string;
}

interface WorkspaceContextValue {
  workspaces: WorkspaceItem[];
  activeId: string | null;
  /** Switch the active workspace optimistically (no page reload → no flicker). */
  setActive: (id: string) => Promise<void>;
  /** Re-read the list + active from the server (after creating one). */
  refresh: () => Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

// Holds the shell's workspace state client-side, hydrated from the server
// (getServerSideProps). Switching updates state in place — the sidebar switcher
// and the workspaces list stay in sync without a full-page reload.
export function WorkspaceProvider({
  initialWorkspaces,
  initialActiveId,
  children,
}: {
  initialWorkspaces: WorkspaceItem[];
  initialActiveId: string | null;
  children: ReactNode;
}) {
  const [workspaces, setWorkspaces] = useState(initialWorkspaces);
  const [activeId, setActiveId] = useState(initialActiveId);

  const setActive = async (id: string) => {
    const previous = activeId;
    setActiveId(id);
    try {
      await trpc.workspace.setActive.mutate({ workspaceId: id });
    } catch (error) {
      setActiveId(previous);
      throw error;
    }
  };

  const refresh = async () => {
    const [list, active] = await Promise.all([trpc.workspace.list.query(), trpc.workspace.active.query()]);
    setWorkspaces(list.workspaces.map(ws => ({ id: ws.id, name: ws.name })));
    setActiveId(active.workspace?.id ?? null);
  };

  return <WorkspaceContext value={{ workspaces, activeId, setActive, refresh }}>{children}</WorkspaceContext>;
}

export function useWorkspaces(): WorkspaceContextValue {
  const context = use(WorkspaceContext);
  if (!context) {
    throw new Error('useWorkspaces must be used within a WorkspaceProvider');
  }
  return context;
}
