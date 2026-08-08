import CheckCircle2 from 'lucide-react/dist/esm/icons/circle-check-big';
import CircleX from 'lucide-react/dist/esm/icons/circle-x';
import Clock3 from 'lucide-react/dist/esm/icons/clock-3';
import LoaderCircle from 'lucide-react/dist/esm/icons/loader-circle';
import TriangleAlert from 'lucide-react/dist/esm/icons/triangle-alert';
import { Badge } from './Badge';
import { cn } from '../../lib/cn';

export type StatusKind =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'attention';

const statusConfig = {
  queued: { label: 'Queued', icon: Clock3, tone: 'neutral' },
  processing: { label: 'Processing', icon: LoaderCircle, tone: 'primary' },
  completed: { label: 'Completed', icon: CheckCircle2, tone: 'success' },
  failed: { label: 'Failed', icon: CircleX, tone: 'danger' },
  attention: { label: 'Needs attention', icon: TriangleAlert, tone: 'warning' },
} as const;

export function StatusBadge({ status }: { status: StatusKind }) {
  const config = statusConfig[status];
  const Icon = config.icon;
  return (
    <Badge tone={config.tone}>
      <Icon
        aria-hidden="true"
        className={cn('size-3.5', status === 'processing' && 'animate-spin')}
      />
      {config.label}
    </Badge>
  );
}
