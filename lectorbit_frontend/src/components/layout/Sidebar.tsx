import { NavLink } from 'react-router';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

interface NavEntry {
  to: string;
  label: string;
  end?: boolean;
  icon: ReactNode;
  description: string;
}

const icon = (path: string) => (
  <svg
    aria-hidden="true"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-4 w-4"
  >
    <path d={path} />
  </svg>
);

const entries: NavEntry[] = [
  {
    to: '/',
    label: 'Today',
    end: true,
    icon: icon('M4 4h16v16H4z M4 9h16'),
    description: 'Your study routine',
  },
  {
    to: '/library',
    label: 'Library',
    icon: icon('M3 5h18v14H3z M3 9h18 M9 5v14'),
    description: 'Indexed media & roots',
  },
  {
    to: '/plan',
    label: 'Plan',
    icon: icon('M4 5h16 M4 12h16 M4 19h10'),
    description: 'Schedule & replan',
  },
  {
    to: '/search',
    label: 'Search',
    icon: icon('M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16z M21 21l-4.3-4.3'),
    description: 'Find a moment',
  },
  {
    to: '/settings',
    label: 'Settings',
    icon: icon('M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z'),
    description: 'Constraints & privacy',
  },
];

export function Sidebar() {
  return (
    <aside
      aria-label="Primary navigation"
      className="flex h-full w-(--sidebar-width) shrink-0 flex-col border-r border-border bg-card/40 backdrop-blur"
    >
      <div className="flex h-(--topbar-height) items-center gap-2 border-b border-border px-4">
        <BrandMark />
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-semibold">LectorBit</span>
          <span className="text-[11px] text-muted-foreground">Study planner</span>
        </div>
      </div>

      <nav className="scrollbar-thin flex flex-1 flex-col gap-1 overflow-y-auto p-3">
        {entries.map((entry) => (
          <NavLink
            key={entry.to}
            to={entry.to}
            end={entry.end}
            className={({ isActive }) =>
              cn(
                'group flex items-start gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                'hover:bg-accent hover:text-accent-foreground',
                isActive && 'bg-accent text-accent-foreground',
              )
            }
          >
            <span
              className={cn(
                'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition-colors',
                'group-hover:text-accent-foreground',
              )}
            >
              {entry.icon}
            </span>
            <span className="flex flex-col leading-tight">
              <span className="font-medium">{entry.label}</span>
              <span className="text-xs text-muted-foreground">{entry.description}</span>
            </span>
          </NavLink>
        ))}
      </nav>

      <div className="border-t border-border px-4 py-3 text-[11px] leading-relaxed text-muted-foreground">
        Offline-first. Your media never leaves this device.
      </div>
    </aside>
  );
}

function BrandMark() {
  return (
    <span
      aria-hidden="true"
      className="grid h-8 w-8 place-items-center rounded-md bg-gradient-to-br from-primary to-primary/70 text-primary-foreground shadow-sm"
    >
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 6h16v12H4z" />
        <path d="M4 10h16" />
        <path d="M9 14l5 3-5 3z" fill="currentColor" />
      </svg>
    </span>
  );
}