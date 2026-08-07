import { PageHeader } from '../../components/layout/PageHeader';
import { EmptyState } from '../../components/feedback/EmptyState';

export function PlanRoute() {
  return (
    <>
      <PageHeader
        eyebrow="Plan"
        title="Schedule"
        description="Deterministic scheduling. Hard constraints are never violated."
      />
      <EmptyState
        title="Planner not yet enabled"
        description="Constraint editing arrives in Feature 6 and the planner in Feature 7."
      />
    </>
  );
}