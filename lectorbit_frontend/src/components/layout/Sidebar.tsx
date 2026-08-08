import CalendarDays from 'lucide-react/dist/esm/icons/calendar-days';
import Film from 'lucide-react/dist/esm/icons/film';
import Gauge from 'lucide-react/dist/esm/icons/gauge';
import LibraryBig from 'lucide-react/dist/esm/icons/library-big';
import ListChecks from 'lucide-react/dist/esm/icons/list-checks';
import Search from 'lucide-react/dist/esm/icons/search';
import Settings2 from 'lucide-react/dist/esm/icons/settings-2';
import { NavLink } from 'react-router';
import type { ComponentType, SVGProps } from 'react';
import { cn } from '../../lib/cn';

interface NavEntry {
  to: string;
  label: string;
  end?: boolean;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  description: string;
}

const entries: NavEntry[] = [
  {
    to: '/',
    label: 'Today',
    end: true,
    icon: CalendarDays,
    description: 'Your study routine',
  },
  {
    to: '/library',
    label: 'Library',
    icon: LibraryBig,
    description: 'Indexed media & roots',
  },
  {
    to: '/plan',
    label: 'Plan',
    icon: ListChecks,
    description: 'Schedule & replan',
  },
  {
    to: '/search',
    label: 'Search',
    icon: Search,
    description: 'Find a moment',
  },
  {
    to: '/settings',
    label: 'Settings',
    icon: Settings2,
    description: 'Constraints & privacy',
  },
  {
    to: '/diagnostics',
    label: 'Diagnostics',
    icon: Gauge,
    description: 'App health snapshot',
  },
];

export function Sidebar() {
  return (
    <aside
      aria-label="Primary navigation"
      className="flex h-full w-(--sidebar-width) shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground"
    >
      <div className="flex h-(--topbar-height) items-center gap-2.5 border-b border-sidebar-border px-4">
        <BrandMark />
        <div className="flex flex-col leading-tight">
          <span className="font-display text-sm font-semibold tracking-tight">
            LectorBit
          </span>
          <span className="text-[11px] text-muted-foreground">Study planner</span>
        </div>
      </div>

      <nav className="scrollbar-thin flex flex-1 flex-col gap-1 overflow-y-auto p-3">
        {entries.map((entry) => {
          const Icon = entry.icon;
          return (
            <NavLink
              key={entry.to}
              to={entry.to}
              end={entry.end}
              className={({ isActive }) =>
                cn(
                  'group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors duration-150',
                  'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                  isActive &&
                    'bg-sidebar-accent text-sidebar-accent-foreground',
                )
              }
            >
              <span
                aria-hidden="true"
                className="grid size-8 shrink-0 place-items-center rounded-md border border-sidebar-border bg-background/60 text-muted-foreground transition-colors duration-150 group-hover:text-sidebar-accent-foreground"
              >
                <Icon className="size-4" />
              </span>
              <span className="flex min-w-0 flex-col leading-tight">
                <span className="font-medium">{entry.label}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {entry.description}
                </span>
              </span>
            </NavLink>
          );
        })}
      </nav>

      <div className="border-t border-sidebar-border px-4 py-3 text-[11px] leading-relaxed text-muted-foreground">
        Offline-first. Your media never leaves this device.
      </div>
    </aside>
  );
}

function BrandMark() {
  return (
    <span
      aria-hidden="true"
      className="grid size-8 place-items-center rounded-lg bg-vermillion-500 text-white shadow-sm dark:bg-primary dark:text-primary-foreground"
    >
      <Film className="size-4" strokeWidth={2} />
    </span>
  );
}
