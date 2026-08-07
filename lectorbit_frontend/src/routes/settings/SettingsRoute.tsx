import { PageHeader } from '../../components/layout/PageHeader';
import { EmptyState } from '../../components/feedback/EmptyState';

export function SettingsRoute() {
  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Constraints & privacy"
        description="Tune your study constraints, manage consent, and inspect diagnostics."
      />
      <EmptyState
        title="Settings not yet available"
        description="Constraint editor arrives in Feature 6, consent in Feature 13, diagnostics in Feature 2."
      />
    </>
  );
}