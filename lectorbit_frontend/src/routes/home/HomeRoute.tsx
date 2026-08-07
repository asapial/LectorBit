import { Link } from 'react-router';
import { cn } from '../../lib/cn';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { PageHeader } from '../../components/layout/PageHeader';
import { EmptyState } from '../../components/feedback/EmptyState';

const features: Array<{
  title: string;
  body: string;
  badge: string;
  to: string;
}> = [
  {
    title: 'Import a library',
    body: 'Register a folder of lectures or tutorials. The scan indexes what you have without copying anything.',
    badge: 'Step 1',
    to: '/library',
  },
  {
    title: 'Set your constraints',
    body: 'Daily minutes, allowed weekdays, deadlines. The planner respects them — no exceptions.',
    badge: 'Step 2',
    to: '/settings',
  },
  {
    title: 'Follow the routine',
    body: 'Open Today to play your next chunk. Progress feeds the next plan automatically.',
    badge: 'Step 3',
    to: '/',
  },
];

export function HomeRoute() {
  return (
    <>
      <PageHeader
        eyebrow="Today"
        title="Welcome back"
        description="LectorBit plans your study from your own constraints — not your motivation. Start by importing a library."
        actions={
          <Link
            to="/library"
            className={cn(
              'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            )}
          >
            <PlusIcon /> Add a library
          </Link>
        }
      />

      <section aria-label="Get started" className="grid gap-4 md:grid-cols-3">
        {features.map((feature) => (
          <Card key={feature.title} className="flex flex-col">
            <CardHeader>
              <Badge tone="primary" className="w-fit">
                {feature.badge}
              </Badge>
              <CardTitle>{feature.title}</CardTitle>
              <CardDescription>{feature.body}</CardDescription>
            </CardHeader>
            <CardContent className="mt-auto pt-0">
              <Link
                to={feature.to}
                className="text-sm font-medium text-primary hover:underline"
              >
                Continue →
              </Link>
            </CardContent>
          </Card>
        ))}
      </section>

      <section className="mt-10">
        <EmptyState
          title="No library yet"
          description="Add a folder to begin. Your media stays on your machine — LectorBit only reads metadata."
          action={
            <Link
              to="/library"
              className={cn(
                'inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              )}
            >
              Choose a folder
            </Link>
          }
        />
      </section>
    </>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}