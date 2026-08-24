import { Link } from 'react-router';
import { PageHeader } from '../components/layout/PageHeader';
import { cn } from '../lib/cn';

export function NotFoundRoute() {
  return (
    <PageHeader
      eyebrow="404"
      title="Nothing here"
      description="The page you were looking for does not exist yet — or has moved."
      actions={
        <Link
          to="/"
          className={cn(
            'inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          )}
        >
          Back to Today
        </Link>
      }
    />
  );
}