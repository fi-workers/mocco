import Link from 'next/link';

import { Routes } from '@frontend/lib/routes';
import { cn } from '@frontend/lib/utils';

export const OtaTabs = {
  hosted: 'hosted',
  ownTool: 'ownTool',
} as const;
export type OtaTab = (typeof OtaTabs)[keyof typeof OtaTabs];

interface Props {
  workspaceId: string;
  projectId: string;
  active: OtaTab;
}

// The two ways a project ships OTA updates, under the one "OTA updates" section:
// Mocco hosts them, or the team keeps its own tool and Mocco gates its publishing token.
export default function OtaTabBar({ workspaceId, projectId, active }: Props) {
  const tabs = [
    { key: OtaTabs.hosted, label: 'Hosted by Mocco', href: Routes.projectOtaHosting(workspaceId, projectId) },
    { key: OtaTabs.ownTool, label: 'Your OTA tool', href: Routes.projectOtaTokens(workspaceId, projectId) },
  ];
  return (
    <nav aria-label="OTA updates" className="flex gap-1 border-b border-border">
      {tabs.map(tab => (
        <Link
          key={tab.key}
          href={tab.href}
          aria-current={tab.key === active ? 'page' : undefined}
          className={cn(
            '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition',
            tab.key === active
              ? 'border-foreground text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}>
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
