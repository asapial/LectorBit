import { Fragment, useState } from 'react';
import type { FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import ArrowRight from 'lucide-react/dist/esm/icons/arrow-right';
import Captions from 'lucide-react/dist/esm/icons/captions';
import FileVideo from 'lucide-react/dist/esm/icons/file-video';
import NotebookPen from 'lucide-react/dist/esm/icons/notebook-pen';
import Search from 'lucide-react/dist/esm/icons/search';
import { Link } from 'react-router';
import { PageHeader } from '../../components/layout/PageHeader';
import { EmptyState, ErrorPanel } from '../../components/feedback/EmptyState';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardContent } from '../../components/ui/Card';
import { searchLibrary, type SearchHit } from '../../ipc/search';

export function SearchRoute() {
  const [draft, setDraft] = useState('');
  const [submitted, setSubmitted] = useState('');
  const results = useQuery({
    queryKey: ['search', submitted] as const,
    queryFn: () => searchLibrary(submitted),
    enabled: submitted.length > 0,
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const next = draft.trim();
    if (!next) return;
    if (next === submitted) void results.refetch();
    else setSubmitted(next);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Search"
        title="Find a moment"
        description="Search local media labels, transcript segments, and notes—with timestamp jumps into your active routine."
      />
      <form onSubmit={submit} className="relative" role="search">
        <Search className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <input
          type="search"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Search concepts, phrases, or lesson names"
          aria-label="Search your library"
          className="h-14 w-full rounded-lg border border-input bg-card pl-12 pr-28 text-base shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <Button type="submit" className="absolute right-2 top-2 h-10" disabled={!draft.trim() || results.isFetching}>
          {results.isFetching ? 'Searching…' : 'Search'}
        </Button>
      </form>

      {!submitted ? (
        <EmptyState
          title="Search your learning library"
          description="Transcript search becomes richer as you transcribe media. Titles are available immediately after a scan."
        />
      ) : null}
      {results.isPending && submitted ? <SearchSkeleton /> : null}
      {results.isError ? <ErrorPanel title="Search could not complete" error={results.error} onRetry={() => void results.refetch()} /> : null}
      {results.data?.length === 0 ? (
        <EmptyState
          title="No matching moments"
          description={`Nothing in the local index matched “${submitted}”. Try fewer or broader words.`}
        />
      ) : null}
      {results.data && results.data.length > 0 ? (
        <section aria-label="Search results" className="space-y-3">
          <p className="text-xs font-medium uppercase tracking-[0.1em] text-muted-foreground">
            {results.data.length} {results.data.length === 1 ? 'result' : 'results'}
          </p>
          {results.data.map((hit, index) => <SearchResult key={`${hit.source}-${hit.media_id}-${hit.start_ms ?? index}`} hit={hit} />)}
        </section>
      ) : null}
    </div>
  );
}

function SearchResult({ hit }: { hit: SearchHit }) {
  const source = sourceLabel(hit.source);
  const target = hit.plan_item_id
    ? `/player/${encodeURIComponent(hit.plan_item_id)}${hit.start_ms === null ? '' : `?t=${hit.start_ms}`}`
    : undefined;
  return (
    <Card className="transition-colors hover:border-primary/35">
      <CardContent className="flex items-start gap-4 pt-6">
        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-accent text-accent-foreground">{source.icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-medium">{hit.display_name}</h2>
            <Badge tone={hit.source === 'transcript' ? 'primary' : 'neutral'}>{source.label}</Badge>
            {hit.start_ms !== null ? <span className="font-mono text-xs text-muted-foreground">{formatTimestamp(hit.start_ms)}</span> : null}
          </div>
          <p className="mt-2 text-sm leading-6 text-muted-foreground"><HighlightedSnippet text={hit.snippet} /></p>
          {!target && hit.start_ms !== null ? <p className="mt-2 text-xs text-muted-foreground">Add this media to an active plan to jump directly to the moment.</p> : null}
        </div>
        {target ? (
          <Link to={target} className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-primary transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Open <ArrowRight className="size-3.5" />
          </Link>
        ) : null}
      </CardContent>
    </Card>
  );
}

function HighlightedSnippet({ text }: { text: string }) {
  const pieces = text.split(/(<mark>|<\/mark>)/);
  let marked = false;
  return pieces.map((piece, index) => {
    if (piece === '<mark>') { marked = true; return null; }
    if (piece === '</mark>') { marked = false; return null; }
    return marked ? <mark key={index} className="rounded-sm bg-accent px-0.5 text-accent-foreground">{piece}</mark> : <Fragment key={index}>{piece}</Fragment>;
  });
}

function sourceLabel(source: SearchHit['source']) {
  switch (source) {
    case 'transcript': return { label: 'Transcript', icon: <Captions className="size-5" /> };
    case 'annotation': return { label: 'Note', icon: <NotebookPen className="size-5" /> };
    default: return { label: 'Media', icon: <FileVideo className="size-5" /> };
  }
}

function SearchSkeleton() {
  return <div className="space-y-3" aria-label="Searching"><div className="h-28 animate-pulse rounded-lg border bg-card motion-reduce:animate-none" /><div className="h-28 animate-pulse rounded-lg border bg-card motion-reduce:animate-none" /></div>;
}

function formatTimestamp(milliseconds: number) {
  const total = Math.floor(milliseconds / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
}
