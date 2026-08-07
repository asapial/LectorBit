import { PageHeader } from '../../components/layout/PageHeader';
import { EmptyState } from '../../components/feedback/EmptyState';

export function SearchRoute() {
  return (
    <>
      <PageHeader
        eyebrow="Search"
        title="Find a moment"
        description="FTS5 over media labels and transcripts. Lands in Feature 11."
      />
      <EmptyState
        title="Search disabled"
        description="The search pipeline is scaffolded but not wired until Feature 11."
      />
    </>
  );
}