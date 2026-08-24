import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Captions from 'lucide-react/dist/esm/icons/captions';
import CheckCircle2 from 'lucide-react/dist/esm/icons/circle-check-big';
import Pencil from 'lucide-react/dist/esm/icons/pencil';
import Search from 'lucide-react/dist/esm/icons/search';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../components/ui/Card';
import {
  correctTranscriptSegment,
  getTranscriptDocument,
  type TranscriptDocument,
} from '../../ipc/analysis';
import { cn } from '../../lib/cn';

export function TranscriptPanel({
  mediaId,
  positionMs,
  onSeek,
}: {
  mediaId: string;
  positionMs: number;
  onSeek: (atMs: number) => void;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState<number>();
  const [draft, setDraft] = useState('');
  const [follow, setFollow] = useState(true);
  const activeRef = useRef<HTMLButtonElement>(null);
  const transcript = useQuery({
    queryKey: ['analysis', 'transcript-document', mediaId] as const,
    queryFn: () => getTranscriptDocument(mediaId),
    retry: false,
  });
  const correction = useMutation({
    mutationFn: (input: { document: TranscriptDocument; segmentId: number; text: string }) =>
      correctTranscriptSegment({
        mediaId,
        transcriptId: input.document.id,
        segmentId: input.segmentId,
        text: input.text,
      }),
    onSuccess: async () => {
      setEditingId(undefined);
      setDraft('');
      await queryClient.invalidateQueries({ queryKey: ['analysis', 'transcript'] });
      await queryClient.invalidateQueries({ queryKey: ['analysis', 'transcript-document'] });
      await queryClient.invalidateQueries({ queryKey: ['learning'] });
      await queryClient.invalidateQueries({ queryKey: ['search'] });
      await queryClient.invalidateQueries({ queryKey: ['ai-studio', 'artifacts'] });
    },
  });
  const segments = transcript.data?.segments ?? [];
  const active = segments.find(
    (segment) => positionMs >= segment.start_ms && positionMs < segment.end_ms,
  );
  const uncertainCount = segments.filter(
    (segment) => segment.confidence_milli !== null && segment.confidence_milli < 650,
  ).length;
  const visible = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    return term
      ? segments.filter((segment) => segment.text.toLocaleLowerCase().includes(term))
      : segments;
  }, [search, segments]);

  useEffect(() => {
    if (follow && !search.trim())
      activeRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [active?.id, follow, search]);

  return (
    <Card className="overflow-hidden">
      <CardHeader className="border-b border-border/70 bg-muted/15">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Captions className="size-4 text-primary" /> Synchronized transcript
            </CardTitle>
            <CardDescription className="mt-1">
              Search, follow playback, seek to evidence, or correct a segment. Corrections create a
              new version.
            </CardDescription>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <label className="relative min-w-64">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                aria-label="Search this transcript"
                className="form-control pl-9"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search this lecture"
              />
            </label>
            <button
              type="button"
              aria-pressed={follow}
              onClick={() => setFollow((value) => !value)}
              className={cn(
                'rounded-lg border px-3 py-2 text-xs font-semibold',
                follow ? 'border-primary/25 bg-primary/10 text-primary' : 'text-muted-foreground',
              )}
            >
              Follow playback
            </button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-5">
        {transcript.isPending ? (
          <div className="h-72 animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />
        ) : null}
        {transcript.isError ? (
          <p className="rounded-xl border border-warning/25 bg-warning/10 p-4 text-sm text-muted-foreground">
            The transcript text could not be loaded. Playback remains available.
          </p>
        ) : null}
        {!transcript.isPending && !transcript.data ? (
          <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
            Create a local transcript to unlock synchronized evidence.
          </p>
        ) : null}
        {transcript.data ? (
          <>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex gap-2">
                <Badge tone="primary">{transcript.data.language.toUpperCase()}</Badge>
                <Badge>{transcript.data.segments.length.toLocaleString()} segments</Badge>
                {uncertainCount > 0 ? (
                  <Badge tone="warning">{uncertainCount} uncertain</Badge>
                ) : null}
              </div>
              <span className="font-mono text-[10px] text-muted-foreground">
                {transcript.data.analyzer_version}
              </span>
            </div>
            <div
              className="max-h-[32rem] space-y-1 overflow-y-auto rounded-xl border bg-background p-2"
              aria-label="Transcript segments"
            >
              {visible.map((segment) =>
                editingId === segment.id ? (
                  <div
                    key={segment.id}
                    className="rounded-lg border border-primary/30 bg-primary/5 p-3"
                  >
                    <p className="font-mono text-[10px] text-primary">
                      {formatTimestamp(segment.start_ms)}–{formatTimestamp(segment.end_ms)}
                    </p>
                    <textarea
                      aria-label={`Correct transcript at ${formatTimestamp(segment.start_ms)}`}
                      className="form-control mt-2 min-h-24"
                      maxLength={8000}
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                    />
                    <p className="mt-2 text-xs text-muted-foreground">
                      Saving creates a new transcript version and marks downstream AI artifacts
                      stale.
                    </p>
                    {correction.isError ? (
                      <p className="mt-2 text-xs text-destructive" role="alert">
                        The correction could not be saved. Refresh if the transcript changed
                        elsewhere.
                      </p>
                    ) : null}
                    <div className="mt-3 flex gap-2">
                      <Button
                        size="sm"
                        disabled={correction.isPending || !draft.trim()}
                        onClick={() =>
                          correction.mutate({
                            document: transcript.data!,
                            segmentId: segment.id,
                            text: draft,
                          })
                        }
                      >
                        {correction.isPending ? 'Saving…' : 'Save correction'}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={correction.isPending}
                        onClick={() => setEditingId(undefined)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div
                    key={segment.id}
                    className={cn(
                      'group flex items-start gap-2 rounded-lg border border-transparent p-2 transition-colors hover:bg-muted/35',
                      active?.id === segment.id && 'border-primary/20 bg-primary/5',
                      segment.confidence_milli !== null &&
                        segment.confidence_milli < 650 &&
                        'border-warning/20 bg-warning/5',
                    )}
                  >
                    <button
                      ref={active?.id === segment.id ? activeRef : undefined}
                      type="button"
                      onClick={() => onSeek(segment.start_ms)}
                      className="min-w-16 rounded-md px-2 py-1 font-mono text-[10px] font-semibold text-primary hover:bg-primary/10"
                    >
                      {formatTimestamp(segment.start_ms)}
                    </button>
                    <p className="min-w-0 flex-1 text-sm leading-6">
                      {highlight(segment.text, search)}
                    </p>
                    {segment.confidence_milli !== null ? (
                      <span
                        className={cn(
                          'mt-1 shrink-0 font-mono text-[10px] text-muted-foreground',
                          segment.confidence_milli < 650 && 'font-semibold text-warning',
                        )}
                        title="Whisper token confidence"
                      >
                        {Math.round(segment.confidence_milli / 10)}%
                      </span>
                    ) : null}
                    <button
                      type="button"
                      aria-label={`Edit transcript at ${formatTimestamp(segment.start_ms)}`}
                      onClick={() => {
                        setEditingId(segment.id);
                        setDraft(segment.text);
                      }}
                      className="rounded-md p-2 text-muted-foreground opacity-60 hover:bg-muted hover:text-foreground group-hover:opacity-100"
                    >
                      <Pencil className="size-3.5" />
                    </button>
                  </div>
                ),
              )}
              {visible.length === 0 ? (
                <p className="p-5 text-center text-sm text-muted-foreground">
                  No transcript segments match this search.
                </p>
              ) : null}
            </div>
            {correction.isSuccess ? (
              <p className="mt-3 flex items-center gap-2 text-xs text-success" role="status">
                <CheckCircle2 className="size-3.5" /> Correction saved as a new transcript version.
              </p>
            ) : null}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function formatTimestamp(milliseconds: number) {
  const total = Math.floor(milliseconds / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function highlight(text: string, query: string) {
  const term = query.trim();
  if (!term) return text;
  const index = text.toLocaleLowerCase().indexOf(term.toLocaleLowerCase());
  if (index < 0) return text;
  return (
    <>
      {text.slice(0, index)}
      <mark className="rounded-sm bg-accent px-0.5 text-accent-foreground">
        {text.slice(index, index + term.length)}
      </mark>
      {text.slice(index + term.length)}
    </>
  );
}
