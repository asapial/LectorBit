import CalendarDays from 'lucide-react/dist/esm/icons/calendar-days';
import Gauge from 'lucide-react/dist/esm/icons/gauge';
import LibraryBig from 'lucide-react/dist/esm/icons/library-big';
import ListChecks from 'lucide-react/dist/esm/icons/list-checks';
import Search from 'lucide-react/dist/esm/icons/search';
import Settings2 from 'lucide-react/dist/esm/icons/settings-2';
import ShieldCheck from 'lucide-react/dist/esm/icons/shield-check';
import Sparkles from 'lucide-react/dist/esm/icons/sparkles';
import { NavLink } from 'react-router';
import type { ComponentType, SVGProps } from 'react';
import { cn } from '../../lib/cn';
import { BrandLogo } from '../brand/BrandLogo';

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
    to: '/ai',
    label: 'AI Studio',
    icon: Sparkles,
    description: 'Models & intelligence',
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
      className="hidden h-full w-(--sidebar-width) shrink-0 flex-col border-r border-sidebar-border bg-sidebar/95 text-sidebar-foreground shadow-[1px_0_0_rgba(0,0,0,0.02)] backdrop-blur-xl min-[1180px]:flex"
    >
      <div className="flex h-(--topbar-height) items-center gap-3 border-b border-sidebar-border/80 px-5">
        <BrandMark />
        <div className="flex flex-col leading-tight">
          <span className="font-display text-[15px] font-semibold tracking-[-0.02em]">
            LectorBit
          </span>
          <span className="text-[11px] text-muted-foreground">Study planner</span>
        </div>
      </div>

      <nav className="scrollbar-thin flex flex-1 flex-col gap-1.5 overflow-y-auto px-3 py-5">
        {entries.map((entry) => {
          const Icon = entry.icon;
          return (
            <NavLink
              key={entry.to}
              to={entry.to}
              end={entry.end}
              className={({ isActive }) =>
                cn(
                  'group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-all duration-200',
                  'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                  isActive &&
                    'bg-sidebar-accent text-sidebar-accent-foreground shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--primary)_12%,transparent)]',
                )
              }
            >
              <span
                aria-hidden="true"
                className="grid size-9 shrink-0 place-items-center rounded-lg border border-sidebar-border/80 bg-background/65 text-muted-foreground shadow-sm transition-all duration-200 group-hover:-translate-y-px group-hover:border-primary/20 group-hover:text-sidebar-accent-foreground"
              >
                <Icon className="size-4" />
              </span>
              <span className="flex min-w-0 flex-col leading-tight">
                <span className="font-medium">{entry.label}</span>
                <span className="truncate text-xs text-muted-foreground">{entry.description}</span>
              </span>
            </NavLink>
          );
        })}
      </nav>

      <div className="m-3 rounded-xl border border-sidebar-border bg-background/55 p-3.5 text-xs leading-relaxed text-muted-foreground shadow-sm">
        <div className="mb-1.5 flex items-center gap-2 font-medium text-sidebar-foreground">
          <ShieldCheck className="size-3.5 text-success" /> Private by design
        </div>
        Media stays local. Cloud intelligence is always opt-in.
      </div>
    </aside>
  );
}

function BrandMark() {
  return (
    <span aria-hidden="true" className="brand-orbit relative grid size-9 place-items-center">
      <BrandLogo className="size-9 drop-shadow-[0_6px_12px_rgba(201,56,21,0.24)]" />
    </span>
  );
}

const mobileEntries = entries.filter((entry) => entry.to !== '/diagnostics');

export function MobileNavigation() {
  return (
    <nav
      aria-label="Mobile navigation"
      className="fixed bottom-3 left-1/2 z-40 grid w-[calc(100%-1.5rem)] max-w-2xl -translate-x-1/2 grid-cols-6 rounded-2xl border border-border/80 bg-card/90 p-1.5 shadow-[0_16px_50px_rgba(28,25,23,0.16)] backdrop-blur-xl supports-[padding:max(0px)]:bottom-[max(0.75rem,env(safe-area-inset-bottom))] min-[1180px]:hidden"
    >
      {mobileEntries.map((entry) => {
        const Icon = entry.icon;
        return (
          <NavLink
            key={entry.to}
            to={entry.to}
            end={entry.end}
            className={({ isActive }) =>
              cn(
                'flex min-w-0 flex-col items-center justify-center gap-1 rounded-xl px-1 py-2 text-[10px] font-medium text-muted-foreground transition-colors',
                'hover:bg-accent hover:text-accent-foreground',
                isActive && 'bg-accent text-accent-foreground',
              )
            }
          >
            <Icon aria-hidden="true" className="size-[18px]" strokeWidth={1.9} />
            <span className="truncate">{entry.label}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}
