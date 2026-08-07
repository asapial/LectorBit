import { PageHeader } from '../../components/layout/PageHeader';
import { EmptyState } from '../../components/feedback/EmptyState';
import { Button } from '../../components/ui/Button';

export function LibraryRoute() {
  return (
    <>
      <PageHeader
        eyebrow="Library"
        title="Indexed media"
        description="Authorized folders, scanned files, and analysis state. Coming in Feature 3."
        actions={
          <Button disabled aria-disabled="true" title="Wired in Feature 3">
            Add folder
          </Button>
        }
      />
      <EmptyState
        title="No roots registered"
        description="The folder picker and scan machinery land in Feature 3. Until then, the UI is intentionally empty."
      />
    </>
  );
}