import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import ArrowLeft from 'lucide-react/dist/esm/icons/arrow-left';
import BookOpen from 'lucide-react/dist/esm/icons/book-open';
import Camera from 'lucide-react/dist/esm/icons/camera';
import Brain from 'lucide-react/dist/esm/icons/brain';
import CheckCircle2 from 'lucide-react/dist/esm/icons/circle-check-big';
import Captions from 'lucide-react/dist/esm/icons/captions';
import Clock3 from 'lucide-react/dist/esm/icons/clock-3';
import ChevronDown from 'lucide-react/dist/esm/icons/chevron-down';
import Download from 'lucide-react/dist/esm/icons/download';
import FastForward from 'lucide-react/dist/esm/icons/fast-forward';
import Flag from 'lucide-react/dist/esm/icons/flag';
import Keyboard from 'lucide-react/dist/esm/icons/keyboard';
import Maximize2 from 'lucide-react/dist/esm/icons/maximize-2';
import Minimize2 from 'lucide-react/dist/esm/icons/minimize-2';
import Pause from 'lucide-react/dist/esm/icons/pause';
import Play from 'lucide-react/dist/esm/icons/play';
import LoaderCircle from 'lucide-react/dist/esm/icons/loader-circle';
import MessageCircle from 'lucide-react/dist/esm/icons/message-circle';
import RefreshCcw from 'lucide-react/dist/esm/icons/refresh-ccw';
import Repeat2 from 'lucide-react/dist/esm/icons/repeat-2';
import Rewind from 'lucide-react/dist/esm/icons/rewind';
import Scissors from 'lucide-react/dist/esm/icons/scissors';
import Square from 'lucide-react/dist/esm/icons/square';
import Sparkles from 'lucide-react/dist/esm/icons/sparkles';
import TriangleAlert from 'lucide-react/dist/esm/icons/triangle-alert';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { PageHeader } from '../../components/layout/PageHeader';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../components/ui/Card';
import {
  closePlayback,
  getPlaybackCapability,
  getPlaybackState,
  openPlayback,
  pausePlayback,
  playPlayback,
  recordStudyAction,
  seekPlayback,
  setPlaybackSpeed,
  syncPlayback,
  type PlaybackCapability,
  type PlaybackEvent,
  type PlaybackView,
  type StudyAction,
} from '../../ipc/playback';
import { getCloudPlanningStatus, replanActive } from '../../ipc/planner';
import {
  getAnalysisCapability,
  getTranscriptState,
  installModel,
  listModels,
  startTranscription,
  type AnalysisCapability,
  type AnalysisProgress,
  type LocalModel,
  type TranscriptionLanguage,
} from '../../ipc/analysis';
import {
  askCompanion,
  explainFrame,
  generateStudyMaterials,
  getLectureUnderstanding,
  listExplanationNotes,
  listStudyMaterials,
  recordReview,
  startLectureUnderstanding,
  type CompanionAction,
  type LearningProgress,
  type StudyItem,
} from '../../ipc/learning';
import {
  createLearningAnnotation,
  listLearningAnnotations,
  removeLearningAnnotation,
  setLearningAnnotationReviewed,
  type AnnotationKind,
  type LearningAnnotation,
} from '../../ipc/annotations';
import { cn } from '../../lib/cn';

type Phase = 'loading' | 'ready' | 'closed' | 'error';

type LearningMarkerKind = AnnotationKind;
type LearningMarker = LearningAnnotation;

type ReplayLoop = {
  start_ms: number;
  end_ms: number;
};

const actionMessages: Record<StudyAction, string> = {
  complete: 'Marked complete.',
  skip: 'Skipped. Replan to remove it from future work.',
  postpone: 'Postponed. Replan when you are ready to move it.',
  split: 'Split point saved for the next plan.',
  repeat: 'Queued to repeat in the next plan.',
  must_watch: 'Marked must watch for the next plan.',
};

const companionActions: Array<{ action: CompanionAction; label: string }> = [
  { action: 'explain_section', label: 'Explain this section' },
  { action: 'summarize_five_minutes', label: 'Summarize last five minutes' },
  { action: 'give_example', label: 'Give me an example' },
  { action: 'quiz_chapter', label: 'Quiz me on this chapter' },
  { action: 'define_terms', label: 'Define the terms used here' },
];

export function PlayerRoute() {
  const { itemId = '' } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<Phase>('loading');
  const [capability, setCapability] = useState<PlaybackCapability>();
  const [view, setView] = useState<PlaybackView>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [actionPending, setActionPending] = useState<StudyAction>();
  const [actionMessage, setActionMessage] = useState<string>();
  const [confirmSkip, setConfirmSkip] = useState(false);
  const [seekDraft, setSeekDraft] = useState<number>();
  const [replanPending, setReplanPending] = useState(false);
  const [learningConsent, setLearningConsent] = useState(false);
  const [learningStatus, setLearningStatus] = useState<string>();
  const [learningError, setLearningError] = useState<string>();
  const [transcriptionLanguage, setTranscriptionLanguage] = useState<TranscriptionLanguage>('en');
  const [modelInstallProgress, setModelInstallProgress] = useState<AnalysisProgress>();
  const [modelInstallTargetId, setModelInstallTargetId] = useState<string>();
  const [lectureJobActive, setLectureJobActive] = useState(false);
  const [transcriptionProgress, setTranscriptionProgress] = useState<AnalysisProgress>();
  const [revealedStudyItem, setRevealedStudyItem] = useState<string>();
  const [reviewStartedAt, setReviewStartedAt] = useState<number>();
  const [reviewConfidence, setReviewConfidence] = useState(3);
  const [companionResultMediaId, setCompanionResultMediaId] = useState<string>();
  const [focusMode, setFocusMode] = useState(false);
  const [shortcutsExpanded, setShortcutsExpanded] = useState(false);
  const [studyToolsExpanded, setStudyToolsExpanded] = useState(false);
  const [sessionGoal, setSessionGoal] = useState('');
  const [markerDraft, setMarkerDraft] = useState('');
  const [markerStatus, setMarkerStatus] = useState<string>();
  const [markerError, setMarkerError] = useState<string>();
  const [replayLoop, setReplayLoop] = useState<ReplayLoop>();
  const videoRef = useRef<HTMLVideoElement>(null);
  const lastVideoRef = useRef<HTMLVideoElement>(null);
  const viewRef = useRef<PlaybackView | undefined>(undefined);
  const syncPendingRef = useRef<Promise<PlaybackView> | null>(null);
  const closePendingRef = useRef<Promise<void> | null>(null);
  const closeRequestedRef = useRef(false);
  const shortcutActionsRef = useRef<{
    togglePlayback: () => void;
    seekBy: (milliseconds: number) => void;
    toggleFocus: () => void;
  }>({
    togglePlayback: () => undefined,
    seekBy: () => undefined,
    toggleFocus: () => undefined,
  });

  useEffect(() => {
    setSessionGoal(loadSessionGoal(itemId));
    setLearningConsent(false);
    setLearningStatus(undefined);
    setLearningError(undefined);
    setLectureJobActive(false);
    setTranscriptionProgress(undefined);
    setRevealedStudyItem(undefined);
    setReviewStartedAt(undefined);
    setCompanionResultMediaId(undefined);
    setStudyToolsExpanded(false);
  }, [itemId]);

  useEffect(() => {
    setMarkerDraft('');
    setMarkerStatus(undefined);
    setMarkerError(undefined);
    setReplayLoop(undefined);
  }, [itemId, view?.media_id, view?.plan_item_id, view?.raw_end_ms, view?.raw_start_ms]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (isEditableShortcutTarget(event.target)) return;
      if (event.key === 'Escape') {
        setFocusMode(false);
        return;
      }
      if (event.key.toLocaleLowerCase() === 'f') {
        event.preventDefault();
        shortcutActionsRef.current.toggleFocus();
        return;
      }
      if (event.key === ' ' || event.key.toLocaleLowerCase() === 'k') {
        event.preventDefault();
        shortcutActionsRef.current.togglePlayback();
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        shortcutActionsRef.current.seekBy(-10_000);
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        shortcutActionsRef.current.seekBy(10_000);
      }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, []);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  const attachVideo = useCallback((video: HTMLVideoElement | null) => {
    videoRef.current = video;
    if (video) lastVideoRef.current = video;
  }, []);

  const analysisModelsQuery = useQuery({
    queryKey: ['analysis', 'models'] as const,
    queryFn: listModels,
    staleTime: 5_000,
    refetchInterval: (query) =>
      query.state.data?.some((model) => model.state === 'downloading') ? 1_500 : false,
  });
  const analysisCapabilityQuery = useQuery({
    queryKey: ['analysis', 'capability'] as const,
    queryFn: getAnalysisCapability,
    staleTime: 5_000,
  });
  const readyTranscriptionModel = selectTranscriptionModel(
    analysisModelsQuery.data,
    transcriptionLanguage,
    'ready',
  );
  const installableTranscriptionModel = selectTranscriptionModel(
    analysisModelsQuery.data,
    transcriptionLanguage,
    'installable',
  );
  const transcriptQuery = useQuery({
    queryKey: ['analysis', 'transcript', view?.media_id] as const,
    queryFn: () => getTranscriptState(view!.media_id),
    enabled: Boolean(view?.media_id),
    refetchInterval: (query) => (isTranscriptActive(query.state.data?.status) ? 1_500 : false),
  });
  useEffect(() => {
    const recordedLanguage = transcriptQuery.data?.language;
    if (recordedLanguage === 'en' || recordedLanguage === 'bn') {
      setTranscriptionLanguage(recordedLanguage);
    }
  }, [transcriptQuery.data?.language, view?.media_id]);
  const cloudLearningQuery = useQuery({
    queryKey: ['cloud-planning', 'status'] as const,
    queryFn: getCloudPlanningStatus,
    staleTime: 5_000,
  });

  const lectureQuery = useQuery({
    queryKey: ['learning', 'lecture', view?.media_id] as const,
    queryFn: () => getLectureUnderstanding(view!.media_id),
    enabled: Boolean(view?.media_id),
    refetchInterval: lectureJobActive ? 1_500 : false,
  });
  const notesQuery = useQuery({
    queryKey: ['learning', 'notes', view?.media_id] as const,
    queryFn: () => listExplanationNotes(view!.media_id),
    enabled: Boolean(view?.media_id),
  });
  const studyQuery = useQuery({
    queryKey: ['learning', 'study-materials', view?.media_id] as const,
    queryFn: () => listStudyMaterials(view!.media_id),
    enabled: Boolean(view?.media_id),
  });
  const learningTrailQuery = useQuery({
    queryKey: ['annotations', 'learning-trail', view?.media_id] as const,
    queryFn: () => listLearningAnnotations(view!.media_id),
    enabled: Boolean(view?.media_id),
  });
  const learningMarkers = learningTrailQuery.data ?? [];
  const installTranscriptionModel = useMutation({
    mutationFn: async (model: LocalModel) => {
      setLearningError(undefined);
      setLearningStatus(undefined);
      setModelInstallTargetId(model.id);
      setModelInstallProgress(undefined);
      return installModel(model.id, (event) => {
        setModelInstallProgress(event);
        if (event.event === 'completed') {
          setLearningError(undefined);
          setLearningStatus(`${model.display_name} is verified and ready for local transcription.`);
          void analysisModelsQuery.refetch();
        }
        if (event.event === 'failed') {
          setLearningStatus(undefined);
          setLearningError(event.data.message);
          void analysisModelsQuery.refetch();
        }
      });
    },
    onSuccess: () => {
      void analysisModelsQuery.refetch();
    },
    onError: (cause) => {
      setModelInstallProgress(undefined);
      setLearningStatus(undefined);
      setLearningError(messageFrom(cause));
      void analysisModelsQuery.refetch();
    },
  });
  const transcribeLecture = useMutation({
    mutationFn: async () => {
      if (!view) throw new Error('Open a lecture first.');
      if (!analysisCapabilityQuery.data?.available) {
        throw new Error(
          analysisCapabilityQuery.data?.message ??
            'The local transcription engine is not available yet.',
        );
      }
      if (!analysisCapabilityQuery.data.supported_languages.includes(transcriptionLanguage)) {
        throw new Error(`${transcriptionLanguageLabel(transcriptionLanguage)} is not supported.`);
      }
      if (!readyTranscriptionModel) {
        throw new Error(
          `Install a ${transcriptionLanguageLabel(transcriptionLanguage)} transcription model in Settings first.`,
        );
      }
      setTranscriptionProgress(undefined);
      setLearningError(undefined);
      setLearningStatus('Starting local transcription…');
      return startTranscription(
        view.media_id,
        readyTranscriptionModel.id,
        transcriptionLanguage,
        (event) => {
          setTranscriptionProgress(event);
          if (event.event === 'queued') setLearningStatus('Transcription queued locally.');
          if (event.event === 'extracting') setLearningStatus('Extracting lecture audio locally…');
          if (event.event === 'transcribing') setLearningStatus('Transcribing lecture locally…');
          if (event.event === 'indexing') {
            setLearningStatus(`Indexing ${event.data.segments} transcript segments…`);
          }
          if (event.event === 'completed') {
            setLearningStatus('Transcript ready. Grounded study tools are now available.');
            void transcriptQuery.refetch();
            void queryClient.invalidateQueries({ queryKey: ['search'] });
          }
          if (event.event === 'failed') {
            setLearningStatus(undefined);
            setLearningError(event.data.message);
          }
        },
      );
    },
    onSuccess: () => {
      void transcriptQuery.refetch();
    },
    onError: (cause) => {
      setLearningStatus(undefined);
      setLearningError(messageFrom(cause));
      if (analysisErrorKind(cause) === 'sidecar_unavailable') {
        void analysisCapabilityQuery.refetch();
      }
    },
  });
  const generateLecture = useMutation({
    mutationFn: async () => {
      if (!view) throw new Error('Open a lecture first.');
      setLearningError(undefined);
      setLearningStatus('Queuing grounded lecture analysis…');
      assertLearningReady(transcriptQuery.data?.status, cloudLearningQuery.data?.configured);
      return startLectureUnderstanding(view.media_id, learningConsent, handleLearningProgress);
    },
    onSuccess: () => setLectureJobActive(true),
    onError: (cause) => {
      setLectureJobActive(false);
      setLearningStatus(undefined);
      setLearningError(messageFrom(cause));
    },
  });
  const createFrameNote = useMutation({
    mutationFn: async () => {
      const video = videoRef.current;
      if (!view || !video) throw new Error('Wait for the video frame to become available.');
      setLearningError(undefined);
      setLearningStatus('Capturing this frame and its transcript context…');
      assertLearningReady(transcriptQuery.data?.status, cloudLearningQuery.data?.configured);
      const atMs = Math.max(
        view.raw_start_ms,
        Math.min(view.raw_end_ms, Math.round(video.currentTime * 1_000)),
      );
      return explainFrame({
        mediaId: view.media_id,
        atMs,
        imageDataUrl: captureVideoFrame(video),
        consent: learningConsent,
      });
    },
    onSuccess: async (note) => {
      setLearningStatus(`Saved “${note.title}” at ${formatTimestamp(note.at_ms)}.`);
      await notesQuery.refetch();
    },
    onError: (cause) => {
      setLearningStatus(undefined);
      setLearningError(messageFrom(cause));
    },
  });
  const generateMaterials = useMutation({
    mutationFn: async () => {
      if (!view) throw new Error('Open a lecture first.');
      setLearningError(undefined);
      assertLearningReady(transcriptQuery.data?.status, cloudLearningQuery.data?.configured);
      setLearningStatus('Generating grounded study material…');
      return generateStudyMaterials(view.media_id, learningConsent);
    },
    onSuccess: async () => {
      setLearningStatus('Study material is ready. Review dates are scheduled locally.');
      await studyQuery.refetch();
    },
    onError: (cause) => {
      setLearningStatus(undefined);
      setLearningError(messageFrom(cause));
    },
  });
  const submitReview = useMutation({
    mutationFn: async ({ item, quality }: { item: StudyItem; quality: number }) =>
      recordReview({
        studyItemId: item.id,
        quality,
        confidence: reviewConfidence,
        responseTimeMs: Math.max(0, Date.now() - (reviewStartedAt ?? Date.now())),
      }),
    onSuccess: async () => {
      setRevealedStudyItem(undefined);
      setReviewStartedAt(undefined);
      await studyQuery.refetch();
    },
    onError: (cause) => setLearningError(messageFrom(cause)),
  });
  const companion = useMutation({
    mutationFn: async (action: CompanionAction) => {
      if (!view) throw new Error('Open a lecture first.');
      setLearningError(undefined);
      setLearningStatus('Answering from the nearby transcript…');
      assertLearningReady(transcriptQuery.data?.status, cloudLearningQuery.data?.configured);
      return askCompanion({
        mediaId: view.media_id,
        atMs: view.position_ms,
        action,
        consent: learningConsent,
      });
    },
    onSuccess: () => {
      setLearningStatus(undefined);
      setCompanionResultMediaId(view?.media_id);
    },
    onError: (cause) => {
      setLearningStatus(undefined);
      setLearningError(messageFrom(cause));
    },
  });
  const createMarker = useMutation({
    mutationFn: (input: Parameters<typeof createLearningAnnotation>[0]) =>
      createLearningAnnotation(input),
    onSuccess: (marker) => {
      queryClient.setQueryData<LearningMarker[]>(
        ['annotations', 'learning-trail', marker.media_id],
        (current = []) =>
          [marker, ...current.filter((item) => item.id !== marker.id)].slice(0, 100),
      );
      if (viewRef.current?.media_id === marker.media_id) {
        setMarkerDraft('');
        setMarkerError(undefined);
        setMarkerStatus(
          `${marker.kind === 'question' ? 'Question' : 'Takeaway'} saved privately at ${formatTimestamp(marker.at_ms)}.`,
        );
      }
      void queryClient.invalidateQueries({ queryKey: ['search'] });
    },
    onError: (cause, variables) => {
      if (viewRef.current?.media_id === variables.mediaId) {
        setMarkerStatus(undefined);
        setMarkerError(messageFrom(cause));
      }
    },
  });
  const reviewMarker = useMutation({
    mutationFn: (input: Parameters<typeof setLearningAnnotationReviewed>[0]) =>
      setLearningAnnotationReviewed(input),
    onSuccess: (marker) => {
      queryClient.setQueryData<LearningMarker[]>(
        ['annotations', 'learning-trail', marker.media_id],
        (current = []) => current.map((item) => (item.id === marker.id ? marker : item)),
      );
      if (viewRef.current?.media_id === marker.media_id) {
        setMarkerStatus(undefined);
        setMarkerError(undefined);
      }
    },
    onError: (cause, variables) => {
      if (viewRef.current?.media_id === variables.mediaId) {
        setMarkerStatus(undefined);
        setMarkerError(messageFrom(cause));
      }
    },
  });
  const deleteMarker = useMutation({
    mutationFn: async (marker: LearningMarker) => {
      await removeLearningAnnotation({ mediaId: marker.media_id, annotationId: marker.id });
      return marker;
    },
    onSuccess: (marker) => {
      queryClient.setQueryData<LearningMarker[]>(
        ['annotations', 'learning-trail', marker.media_id],
        (current = []) => current.filter((item) => item.id !== marker.id),
      );
      if (viewRef.current?.media_id === marker.media_id) {
        setMarkerError(undefined);
        setMarkerStatus('Marker removed from this device.');
      }
      void queryClient.invalidateQueries({ queryKey: ['search'] });
    },
    onError: (cause, marker) => {
      if (viewRef.current?.media_id === marker.media_id) {
        setMarkerStatus(undefined);
        setMarkerError(messageFrom(cause));
      }
    },
  });

  useEffect(() => {
    if (view?.plan_item_id !== itemId) return;
    if (
      lectureQuery.data ||
      notesQuery.data?.length ||
      studyQuery.data?.length ||
      learningStatus ||
      learningError ||
      (companion.data && companionResultMediaId === view.media_id)
    ) {
      setStudyToolsExpanded(true);
    }
  }, [
    companion.data,
    companionResultMediaId,
    itemId,
    learningStatus,
    learningError,
    lectureQuery.data,
    notesQuery.data?.length,
    studyQuery.data?.length,
    view?.media_id,
    view?.plan_item_id,
  ]);

  useEffect(() => {
    if (lectureQuery.data) setLectureJobActive(false);
  }, [lectureQuery.data]);

  useEffect(() => {
    if (transcriptQuery.data?.status === 'completed' && transcriptionProgress) {
      setLearningError(undefined);
      setLearningStatus('Transcript ready. Grounded study tools are now available.');
    }
  }, [transcriptQuery.data?.status, transcriptionProgress]);

  function revealStudyAnswer(itemId: string) {
    setRevealedStudyItem(itemId);
    setReviewStartedAt(Date.now());
  }

  function handleLearningProgress(event: LearningProgress) {
    if (event.event === 'queued') {
      setLearningError(undefined);
      setLectureJobActive(true);
      setLearningStatus('Lecture analysis queued.');
    }
    if (event.event === 'generating') {
      setLearningError(undefined);
      setLectureJobActive(true);
      setLearningStatus('Reading the grounded transcript…');
    }
    if (event.event === 'validating') {
      setLearningError(undefined);
      setLectureJobActive(true);
      setLearningStatus('Checking transcript citations…');
    }
    if (event.event === 'failed') {
      setLectureJobActive(false);
      setLearningStatus(undefined);
      setLearningError(event.data.message);
    }
    if (event.event === 'completed') {
      setLectureJobActive(false);
      setLearningError(undefined);
      setLearningStatus('Lecture understanding is ready.');
      void lectureQuery.refetch();
    }
  }

  useEffect(() => {
    let disposed = false;
    let opened = false;

    const handleEvent = (event: PlaybackEvent) => {
      if (disposed) return;
      if (event.event === 'state') {
        setView(event.data);
        setPhase('ready');
      } else if (event.event === 'closed') {
        setPhase('closed');
      } else {
        setError(event.data.message);
        setPhase('error');
      }
    };

    async function boot() {
      closeRequestedRef.current = false;
      setPhase('loading');
      setView(undefined);
      setError(undefined);
      if (!itemId) {
        setError('This study block is missing an identifier.');
        setPhase('error');
        return;
      }
      try {
        if (closePendingRef.current) await closePendingRef.current.catch(() => undefined);
        const nextCapability = await getPlaybackCapability();
        if (disposed) return;
        setCapability(nextCapability);
        if (!nextCapability.available) {
          setError('The built-in media player is unavailable. Check Diagnostics.');
          setPhase('error');
          return;
        }
        let nextView = await openPlayback(itemId, handleEvent);
        opened = true;
        const requestedTimestampValue = searchParams.get('t');
        const requestedTimestamp =
          requestedTimestampValue === null ? Number.NaN : Number(requestedTimestampValue);
        if (
          Number.isFinite(requestedTimestamp) &&
          requestedTimestamp >= nextView.raw_start_ms &&
          requestedTimestamp <= nextView.raw_end_ms
        ) {
          nextView = await seekPlayback(requestedTimestamp);
        }
        if (disposed) {
          await closePlayback().catch(() => undefined);
          return;
        }
        setView(nextView);
        setPhase('ready');
      } catch (cause) {
        if (!disposed) {
          setError(messageFrom(cause));
          setPhase('error');
        }
      }
    }

    void boot();
    return () => {
      disposed = true;
      if (opened && !closeRequestedRef.current) void flushAndClosePlayback();
    };
  }, [itemId, searchParams]);

  useEffect(() => {
    if (phase !== 'ready' || !view) return;
    const interval = window.setInterval(() => {
      const video = videoRef.current;
      if (!video || syncPendingRef.current || !Number.isFinite(video.currentTime)) return;
      const position = Math.max(
        view.raw_start_ms,
        Math.min(view.raw_end_ms, Math.round(video.currentTime * 1_000)),
      );
      if (position >= view.raw_end_ms && !video.paused) video.pause();
      const pending = syncPlayback(position, video.paused, video.playbackRate);
      syncPendingRef.current = pending;
      void pending
        .then((next) =>
          setView((current) =>
            current?.completed && !next.completed ? { ...next, completed: true } : next,
          ),
        )
        .catch((cause) => setError(messageFrom(cause)))
        .finally(() => {
          if (syncPendingRef.current === pending) syncPendingRef.current = null;
        });
    }, 1_000);
    return () => window.clearInterval(interval);
  }, [phase, view?.raw_end_ms, view?.raw_start_ms, view?.stream_url]);

  useEffect(() => {
    if (phase !== 'ready') return;
    const syncAtVisibilityBoundary = () => {
      const video = videoRef.current;
      if (!video) return;
      void syncCurrentVideo(video)
        .then(setView)
        .catch((cause) => setError(messageFrom(cause)));
    };
    document.addEventListener('visibilitychange', syncAtVisibilityBoundary);
    window.addEventListener('pagehide', syncAtVisibilityBoundary);
    return () => {
      document.removeEventListener('visibilitychange', syncAtVisibilityBoundary);
      window.removeEventListener('pagehide', syncAtVisibilityBoundary);
    };
  }, [phase]);

  const watchedPercent = useMemo(() => {
    if (!view || view.item_duration_ms === 0) return 0;
    return Math.min(100, Math.floor((view.item_covered_ms / view.item_duration_ms) * 100));
  }, [view]);
  const blockProgressPercent = useMemo(() => {
    if (!view || view.item_duration_ms === 0) return 0;
    const elapsed = clampPosition(view) - view.raw_start_ms;
    return Math.min(100, Math.max(0, Math.round((elapsed / view.item_duration_ms) * 100)));
  }, [view]);
  const remainingMs = view
    ? Math.max(0, Math.round((view.raw_end_ms - clampPosition(view)) / Math.max(view.speed, 0.5)))
    : 0;
  const transcriptReady = transcriptQuery.data?.status === 'completed';
  const cloudLearningReady = cloudLearningQuery.data?.configured === true;
  const learningReady = transcriptReady && cloudLearningReady;
  const actionsDisabled = busy || replanPending || phase !== 'ready' || Boolean(actionPending);

  async function runControl(operation: () => Promise<PlaybackView>) {
    setBusy(true);
    setError(undefined);
    try {
      if (syncPendingRef.current) await syncPendingRef.current.catch(() => undefined);
      const nextView = await operation();
      setView(nextView);
      setSeekDraft(undefined);
      return nextView;
    } catch (cause) {
      setError(messageFrom(cause));
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  async function commitSeek(position = seekDraft, preserveReplayLoop = false) {
    if (position === undefined || !view) return;
    if (!preserveReplayLoop) setReplayLoop(undefined);
    const clamped = Math.max(view.raw_start_ms, Math.min(view.raw_end_ms, position));
    if (videoRef.current) videoRef.current.currentTime = clamped / 1_000;
    await runControl(() => seekPlayback(clamped));
  }

  async function togglePlayback() {
    const video = videoRef.current ?? lastVideoRef.current;
    if (!video || !view) return;
    if (video.paused) {
      try {
        await video.play();
      } catch {
        setError(mediaErrorMessage(video.error));
        return;
      }
      const nextView = await runControl(playPlayback);
      if (!nextView) video.pause();
    } else {
      video.pause();
      await runControl(async () => {
        await syncCurrentVideo(video);
        return pausePlayback();
      });
    }
  }

  function retryMedia() {
    setError(undefined);
    videoRef.current?.load();
  }

  async function changeSpeed(speed: number) {
    const video = videoRef.current;
    const previousSpeed = view?.speed ?? 1;
    const nextView = await runControl(async () => {
      if (video && view && Number.isFinite(video.currentTime)) {
        const position = Math.max(
          view.raw_start_ms,
          Math.min(view.raw_end_ms, Math.round(video.currentTime * 1_000)),
        );
        // Preserve the interval watched at the old rate. Sync updates the
        // embedded engine's live position; seeking to that same position then
        // forces the durable checkpoint before the backend changes speed.
        await syncCurrentVideo(video);
        await seekPlayback(position);
      }
      const changed = await setPlaybackSpeed(speed);
      if (video) video.playbackRate = speed;
      return changed;
    });
    if (!nextView && video) video.playbackRate = previousSpeed;
  }

  async function performAction(kind: StudyAction) {
    if (!view || actionsDisabled) return;
    setActionPending(kind);
    setActionMessage(undefined);
    setError(undefined);
    try {
      const video = videoRef.current;
      const currentPosition =
        video && Number.isFinite(video.currentTime)
          ? Math.round(video.currentTime * 1_000)
          : view.position_ms;
      const actionPosition = Math.max(
        view.raw_start_ms,
        Math.min(view.raw_end_ms, currentPosition),
      );
      if (
        kind === 'split' &&
        (actionPosition <= view.raw_start_ms || actionPosition >= view.raw_end_ms)
      ) {
        setError('Play or seek inside the study block before choosing a split point.');
        return;
      }
      if (kind === 'complete' || kind === 'skip' || kind === 'postpone') {
        video?.pause();
      }
      if (video) {
        const nextView = await syncCurrentVideo(video);
        setView(nextView);
      } else if (syncPendingRef.current) {
        await syncPendingRef.current.catch(() => undefined);
      }
      await recordStudyAction(
        view.plan_item_id,
        kind,
        kind === 'split' ? actionPosition : undefined,
      );
      await queryClient.invalidateQueries({ queryKey: ['planner', 'routine'] });
      const refreshedView = await getPlaybackState();
      setActionMessage(actionMessages[kind]);
      setConfirmSkip(false);
      setView(refreshedView);
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setActionPending(undefined);
    }
  }

  async function stopAndReturn() {
    setBusy(true);
    closeRequestedRef.current = true;
    try {
      if (videoRef.current && phase === 'ready') {
        setView(await syncCurrentVideo(videoRef.current));
      }
      await queryClient.invalidateQueries({ queryKey: ['planner', 'routine'] });
      await closePlayback();
      void navigate('/');
    } catch (cause) {
      closeRequestedRef.current = false;
      setError(messageFrom(cause));
      setBusy(false);
    }
  }

  async function replanRemaining() {
    setReplanPending(true);
    setError(undefined);
    closeRequestedRef.current = true;
    try {
      if (videoRef.current && phase === 'ready') {
        setView(await syncCurrentVideo(videoRef.current));
      }
      await closePlayback();
      await replanActive(localIsoDate());
      await queryClient.invalidateQueries({ queryKey: ['planner', 'routine'] });
      void navigate('/');
    } catch (cause) {
      closeRequestedRef.current = false;
      setError(messageFrom(cause));
      setReplanPending(false);
    }
  }

  async function syncCurrentVideo(video: HTMLVideoElement): Promise<PlaybackView> {
    if (syncPendingRef.current) await syncPendingRef.current.catch(() => undefined);
    // An action can be clicked in the first ready frame, before the effect that
    // mirrors `view` into the lifecycle ref has run. The render-local value is
    // already authoritative in that frame, so use it as the synchronization
    // fallback instead of skipping the checkpoint and only fetching state.
    const currentView = viewRef.current ?? view;
    if (!currentView || !Number.isFinite(video.currentTime)) return getPlaybackState();
    const position = Math.max(
      currentView.raw_start_ms,
      Math.min(currentView.raw_end_ms, Math.round(video.currentTime * 1_000)),
    );
    const pending = syncPlayback(position, video.paused, video.playbackRate);
    syncPendingRef.current = pending;
    try {
      return await pending;
    } finally {
      if (syncPendingRef.current === pending) syncPendingRef.current = null;
    }
  }

  function flushAndClosePlayback(): Promise<void> {
    if (closePendingRef.current) return closePendingRef.current;
    const video = videoRef.current ?? lastVideoRef.current;
    const currentView = viewRef.current;
    const pending = (async () => {
      if (video && currentView && Number.isFinite(video.currentTime)) {
        const position = Math.max(
          currentView.raw_start_ms,
          Math.min(currentView.raw_end_ms, Math.round(video.currentTime * 1_000)),
        );
        if (syncPendingRef.current) await syncPendingRef.current.catch(() => undefined);
        await syncPlayback(position, video.paused, video.playbackRate).catch(() => undefined);
      }
      await closePlayback().catch(() => undefined);
    })();
    closePendingRef.current = pending;
    void pending.finally(() => {
      if (closePendingRef.current === pending) closePendingRef.current = null;
    });
    return pending;
  }

  function updateSessionGoal(value: string) {
    setSessionGoal(value);
    saveSessionGoal(itemId, value);
  }

  function saveLearningMarker(kind: LearningMarkerKind) {
    if (!view) return;
    const text = markerDraft.trim();
    if (!text) return;
    const atMs = currentPlaybackPosition(view, videoRef.current);
    setMarkerStatus(undefined);
    setMarkerError(undefined);
    createMarker.mutate({
      mediaId: view.media_id,
      atMs,
      kind,
      text,
    });
  }

  function toggleLearningMarker(markerId: string) {
    const marker = learningMarkers.find((item) => item.id === markerId);
    if (!view || !marker) return;
    setMarkerError(undefined);
    reviewMarker.mutate({
      mediaId: view.media_id,
      annotationId: marker.id,
      reviewed: !marker.reviewed,
    });
  }

  function removeLearningMarker(markerId: string) {
    const marker = learningMarkers.find((item) => item.id === markerId);
    if (!view || !marker) return;
    setMarkerError(undefined);
    deleteMarker.mutate(marker);
  }

  async function startReplayLoop(durationMs: number) {
    if (!view) return;
    const position = currentPlaybackPosition(view, videoRef.current);
    const hasPreviousContext = position - view.raw_start_ms >= MIN_REPLAY_LOOP_MS;
    const startMs = hasPreviousContext
      ? Math.max(view.raw_start_ms, position - durationMs)
      : view.raw_start_ms;
    const endMs = hasPreviousContext
      ? position
      : Math.min(view.raw_end_ms, view.raw_start_ms + durationMs);
    if (endMs - startMs < MIN_REPLAY_LOOP_MS) return;
    setReplayLoop({ start_ms: startMs, end_ms: endMs });
    await commitSeek(startMs, true);
  }

  shortcutActionsRef.current = {
    togglePlayback: () => {
      if (!busy && phase === 'ready' && view) void togglePlayback();
    },
    seekBy: (milliseconds) => {
      if (!busy && phase === 'ready' && view) {
        void commitSeek(view.position_ms + milliseconds);
      }
    },
    toggleFocus: () => {
      if (phase === 'ready' && view) setFocusMode((current) => !current);
    },
  };

  return (
    <div
      className={cn(
        focusMode &&
          'fixed inset-0 z-[100] overflow-y-auto bg-background px-4 pb-10 pt-4 sm:px-6 lg:px-8',
      )}
    >
      {focusMode ? (
        <header className="mx-auto mb-4 flex max-w-[110rem] flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/20 bg-card/95 px-4 py-3 shadow-lg backdrop-blur">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
              <Play className="size-4" />
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Badge tone="primary">Focus mode</Badge>
                {view ? (
                  <span className="font-mono text-xs text-muted-foreground">
                    {formatDuration(remainingMs)} left
                  </span>
                ) : null}
              </div>
              <p className="mt-1 truncate text-sm font-semibold">
                {view?.display_name ?? 'Study player'}
              </p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => setFocusMode(false)}>
            <Minimize2 className="size-4" /> Exit focus
          </Button>
        </header>
      ) : (
        <PageHeader
          eyebrow="Focused study"
          title={view?.display_name ?? 'Study player'}
          description="One focused block at a time, with private playback, durable progress, and study tools when you need them."
          actions={
            <>
              <Button
                variant="outline"
                size="sm"
                aria-expanded={shortcutsExpanded}
                onClick={() => setShortcutsExpanded((current) => !current)}
              >
                <Keyboard className="size-4" /> Shortcuts
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={phase !== 'ready'}
                onClick={() => setFocusMode(true)}
              >
                <Maximize2 className="size-4" /> Focus mode
              </Button>
              <button
                type="button"
                className={backLinkClass}
                disabled={busy || phase === 'closed'}
                onClick={() => void stopAndReturn()}
              >
                <ArrowLeft className="size-4" /> Routine
              </button>
            </>
          }
        />
      )}

      {!focusMode && shortcutsExpanded ? <ShortcutGuide /> : null}

      {phase === 'loading' ? <PlayerSkeleton /> : null}

      {phase === 'error' && !view ? (
        <Card className="border-destructive/30">
          <CardContent className="flex items-start gap-3 pt-6" role="alert">
            <TriangleAlert className="mt-0.5 size-5 shrink-0 text-destructive" />
            <div>
              <p className="font-medium">Playback could not start</p>
              <p className="mt-1 text-sm text-muted-foreground">{error}</p>
              {capability ? (
                <p className="mt-3 font-mono text-xs text-muted-foreground">
                  {capability.backend} ·{' '}
                  {capability.detected_version ?? capability.expected_version}
                </p>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {view ? (
        <div className={cn('space-y-6', focusMode && 'mx-auto max-w-[110rem]')}>
          {error ? (
            <div
              className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
              role="alert"
            >
              <div className="flex min-w-0 items-start gap-2">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                <span>{error}</span>
              </div>
              <Button variant="outline" size="sm" onClick={retryMedia}>
                <RefreshCcw className="size-3.5" /> Retry stream
              </Button>
            </div>
          ) : null}

          <section
            className="grid gap-4 min-[1320px]:grid-cols-[minmax(0,1.5fr)_minmax(18rem,0.5fr)]"
            aria-label="Playback controls"
          >
            <Card className="overflow-hidden">
              <div className="h-1 bg-primary" />
              <div className="aspect-video bg-stone-950">
                <video
                  ref={attachVideo}
                  src={view.stream_url}
                  className="size-full object-contain"
                  controls
                  crossOrigin="anonymous"
                  playsInline
                  preload="metadata"
                  aria-label={`Playing ${view.display_name}`}
                  onLoadedMetadata={(event) => {
                    event.currentTarget.currentTime = clampPosition(view) / 1_000;
                    event.currentTarget.playbackRate = view.speed;
                  }}
                  onSeeking={(event) => enforceBlockBounds(event.currentTarget, view)}
                  onCanPlay={() => setError(undefined)}
                  onPlay={() =>
                    setView((current) => (current ? { ...current, paused: false } : current))
                  }
                  onPause={() =>
                    setView((current) => (current ? { ...current, paused: true } : current))
                  }
                  onRateChange={(event) => {
                    const speed = event.currentTarget.playbackRate;
                    setView((current) => (current ? { ...current, speed } : current));
                  }}
                  onTimeUpdate={(event) => {
                    const position = enforceBlockBounds(event.currentTarget, view);
                    if (replayLoop && position >= replayLoop.end_ms) {
                      event.currentTarget.currentTime = replayLoop.start_ms / 1_000;
                      setView((current) =>
                        current ? { ...current, position_ms: replayLoop.start_ms } : current,
                      );
                      return;
                    }
                    setView((current) =>
                      current ? { ...current, position_ms: position } : current,
                    );
                    if (position >= view.raw_end_ms) {
                      event.currentTarget.pause();
                      event.currentTarget.currentTime = view.raw_end_ms / 1_000;
                    }
                  }}
                  onError={(event) => setError(mediaErrorMessage(event.currentTarget.error))}
                >
                  {view.caption_tracks.map((track) => (
                    <track
                      key={track.url}
                      kind="captions"
                      src={track.url}
                      srcLang={track.language}
                      label={track.label}
                    />
                  ))}
                </video>
              </div>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <CardTitle>Now studying</CardTitle>
                    <CardDescription className="mt-1">
                      Scheduled segment {formatTimestamp(view.raw_start_ms)}–
                      {formatTimestamp(view.raw_end_ms)} · captions and picture-in-picture stay
                      available in the player.
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-5">
                <div>
                  <div className="mb-2 flex items-center justify-between gap-3 font-mono text-xs text-muted-foreground">
                    <span>{formatTimestamp(seekDraft ?? view.position_ms)}</span>
                    <span>{formatTimestamp(view.raw_end_ms)}</span>
                  </div>
                  <input
                    aria-label="Playback position"
                    className="w-full accent-primary"
                    type="range"
                    min={view.raw_start_ms}
                    max={view.raw_end_ms}
                    step={1_000}
                    value={seekDraft ?? clampPosition(view)}
                    onChange={(event) => setSeekDraft(Number(event.target.value))}
                    disabled={busy || phase === 'closed'}
                  />
                  <div className="mt-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                    <span>Block starts at {formatTimestamp(view.raw_start_ms)}</span>
                    {seekDraft !== undefined ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void commitSeek()}
                        disabled={busy}
                      >
                        Seek here
                      </Button>
                    ) : null}
                  </div>
                </div>

                <div className="grid grid-cols-[auto_minmax(7rem,1fr)_auto] items-center gap-2 sm:flex sm:flex-wrap">
                  <Button
                    aria-label="Rewind 10 seconds"
                    variant="outline"
                    size="icon"
                    disabled={busy || phase === 'closed'}
                    onClick={() => void commitSeek(view.position_ms - 10_000)}
                  >
                    <Rewind className="size-4" />
                  </Button>
                  <Button
                    className="min-w-0 sm:min-w-28"
                    disabled={busy || phase === 'closed'}
                    onClick={() => void togglePlayback()}
                  >
                    {view.paused ? <Play className="size-4" /> : <Pause className="size-4" />}
                    {view.paused ? 'Play' : 'Pause'}
                  </Button>
                  <Button
                    aria-label="Forward 10 seconds"
                    variant="outline"
                    size="icon"
                    disabled={busy || phase === 'closed'}
                    onClick={() => void commitSeek(view.position_ms + 10_000)}
                  >
                    <FastForward className="size-4" />
                  </Button>
                  <label className="col-span-2 flex items-center gap-2 text-sm font-medium sm:ml-auto">
                    Speed
                    <select
                      aria-label="Playback speed"
                      className="h-10 flex-1 rounded-lg border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex-none"
                      value={view.speed}
                      disabled={busy || phase === 'closed'}
                      onChange={(event) => void changeSpeed(Number(event.target.value))}
                    >
                      {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((speed) => (
                        <option key={speed} value={speed}>
                          {speed}×
                        </option>
                      ))}
                    </select>
                  </label>
                  <Button
                    className="col-span-1"
                    variant="ghost"
                    disabled={busy || phase === 'closed'}
                    onClick={() => void stopAndReturn()}
                  >
                    <Square className="size-3.5" /> Close
                  </Button>
                  {!focusMode ? (
                    <Button variant="ghost" onClick={() => setFocusMode(true)}>
                      <Maximize2 className="size-3.5" /> Focus
                    </Button>
                  ) : null}
                </div>

                <section
                  className="flex flex-wrap items-center gap-2 rounded-xl border bg-muted/20 p-3"
                  aria-label="Concept replay"
                >
                  <div className="mr-auto min-w-[13rem]">
                    <p className="flex items-center gap-2 text-sm font-semibold">
                      <Repeat2 className="size-4 text-primary" /> Replay a concept
                    </p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      Repeat the context ending at the current moment until it clicks.
                    </p>
                  </div>
                  {REPLAY_LOOP_DURATIONS_MS.map((durationMs) => (
                    <Button
                      key={durationMs}
                      size="sm"
                      variant="outline"
                      disabled={busy || phase === 'closed'}
                      onClick={() => void startReplayLoop(durationMs)}
                    >
                      Last {durationMs / 1_000}s
                    </Button>
                  ))}
                  {replayLoop ? (
                    <div className="flex w-full flex-wrap items-center justify-between gap-2 border-t pt-3">
                      <Badge tone="primary">
                        <Repeat2 className="size-3" /> Looping{' '}
                        {formatTimestamp(replayLoop.start_ms)}–{formatTimestamp(replayLoop.end_ms)}
                      </Badge>
                      <Button size="sm" variant="ghost" onClick={() => setReplayLoop(undefined)}>
                        Stop loop
                      </Button>
                    </div>
                  ) : null}
                </section>
              </CardContent>
            </Card>

            <aside className="space-y-4 min-[1320px]:sticky min-[1320px]:top-6">
              <Card className="overflow-hidden">
                <CardHeader className="border-b border-border/70 bg-muted/15">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <CardTitle>Session progress</CardTitle>
                      <CardDescription className="mt-1">
                        Playhead progress and verified watching are tracked separately.
                      </CardDescription>
                    </div>
                    <PlaybackBadge view={view} phase={phase} />
                  </div>
                </CardHeader>
                <CardContent className="space-y-5 pt-5">
                  <div className="grid grid-cols-2 gap-3">
                    <SessionMetric label="Time left" value={formatDuration(remainingMs)} />
                    <SessionMetric label="Block position" value={`${blockProgressPercent}%`} />
                  </div>
                  <div>
                    <div className="mb-2 flex items-end justify-between gap-3">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                          Watched coverage
                        </p>
                        <p className="mt-1 font-display text-2xl font-semibold tracking-tight">
                          {watchedPercent}%
                        </p>
                      </div>
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {formatDuration(view.item_covered_ms)} /{' '}
                        {formatDuration(view.item_duration_ms)}
                      </span>
                    </div>
                    <div
                      aria-label="Watched coverage"
                      aria-valuemax={100}
                      aria-valuemin={0}
                      aria-valuenow={watchedPercent}
                      className="h-2.5 overflow-hidden rounded-full bg-secondary"
                      role="progressbar"
                    >
                      <div
                        className="h-full rounded-full bg-primary transition-[width] duration-200 motion-reduce:transition-none"
                        style={{ width: `${watchedPercent}%` }}
                      />
                    </div>
                    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                      Completion happens at 90% verified coverage or when you mark the block done.
                    </p>
                  </div>
                  {!focusMode ? (
                    <div>
                      <label className="text-sm font-semibold" htmlFor="session-intention">
                        Session intention
                      </label>
                      <textarea
                        id="session-intention"
                        aria-describedby="session-intention-help"
                        rows={2}
                        maxLength={160}
                        value={sessionGoal}
                        onChange={(event) => updateSessionGoal(event.target.value)}
                        placeholder="What should you understand by the end?"
                        className="mt-2 w-full resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm font-normal leading-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      />
                      <p
                        id="session-intention-help"
                        className="mt-1 text-[11px] text-muted-foreground"
                      >
                        Saved privately on this device for this study block.
                      </p>
                    </div>
                  ) : null}
                </CardContent>
              </Card>

              <LearningTrail
                markers={learningMarkers}
                draft={markerDraft}
                status={markerStatus}
                error={
                  markerError ??
                  (learningTrailQuery.isError ? messageFrom(learningTrailQuery.error) : undefined)
                }
                loading={learningTrailQuery.isLoading}
                pending={
                  learningTrailQuery.isLoading ||
                  createMarker.isPending ||
                  reviewMarker.isPending ||
                  deleteMarker.isPending
                }
                onDraftChange={(value) => {
                  setMarkerDraft(value);
                  setMarkerStatus(undefined);
                  setMarkerError(undefined);
                }}
                onSave={saveLearningMarker}
                onSeek={(atMs) => void commitSeek(atMs)}
                onToggleReviewed={toggleLearningMarker}
                onRemove={removeLearningMarker}
              />

              <StudyActions
                actionsDisabled={actionsDisabled}
                view={view}
                confirmSkip={confirmSkip}
                setConfirmSkip={setConfirmSkip}
                performAction={performAction}
                busy={busy}
                actionPending={actionPending}
                replanPending={replanPending}
                replanRemaining={replanRemaining}
                actionMessage={actionMessage}
              />
            </aside>
          </section>

          {!focusMode ? (
            <Card className="overflow-hidden border-primary/20">
              <div className="h-1 bg-gradient-to-r from-primary via-vermillion-400 to-amber-400" />
              <CardHeader className={cn(studyToolsExpanded && 'border-b border-primary/10')}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <Sparkles className="size-4 text-primary" /> Study toolkit
                    </CardTitle>
                    <CardDescription className="mt-1 max-w-3xl">
                      Open transcript-grounded explanations, frame notes, chapter navigation, and
                      review cards only when they help.
                    </CardDescription>
                  </div>
                  <div className="flex items-center gap-2">
                    {lectureQuery.data ? (
                      <Badge tone="success">Grounded · {lectureQuery.data.model}</Badge>
                    ) : learningReady ? (
                      <Badge tone="success">Ready</Badge>
                    ) : isTranscriptActive(transcriptQuery.data?.status) ? (
                      <Badge tone="primary">Preparing transcript</Badge>
                    ) : (
                      <Badge tone="warning">Setup needed</Badge>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-expanded={studyToolsExpanded}
                      onClick={() => setStudyToolsExpanded((current) => !current)}
                    >
                      {studyToolsExpanded ? 'Hide tools' : 'Open tools'}
                      <ChevronDown
                        className={cn(
                          'size-4 transition-transform',
                          studyToolsExpanded && 'rotate-180',
                        )}
                      />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              {studyToolsExpanded ? (
                <CardContent className="space-y-5 pt-5">
                  <LearningSetup
                    transcriptStatus={transcriptQuery.data?.status}
                    transcriptSegments={transcriptQuery.data?.segment_count ?? 0}
                    transcriptLanguage={transcriptQuery.data?.language ?? null}
                    transcriptModelId={transcriptQuery.data?.model_id ?? null}
                    transcriptPending={transcriptQuery.isPending}
                    transcriptError={transcriptQuery.isError}
                    retryTranscript={() => void transcriptQuery.refetch()}
                    capability={analysisCapabilityQuery.data}
                    capabilityPending={analysisCapabilityQuery.isPending}
                    capabilityError={analysisCapabilityQuery.isError}
                    retryCapability={() => void analysisCapabilityQuery.refetch()}
                    modelPending={analysisModelsQuery.isPending}
                    modelError={analysisModelsQuery.isError}
                    hasReadyModel={Boolean(readyTranscriptionModel)}
                    installableModel={installableTranscriptionModel}
                    modelInstallProgress={
                      modelInstallTargetId === installableTranscriptionModel?.id
                        ? modelInstallProgress
                        : undefined
                    }
                    modelInstallPending={
                      installTranscriptionModel.isPending &&
                      installTranscriptionModel.variables?.id === installableTranscriptionModel?.id
                    }
                    installSelectedModel={() => {
                      if (installableTranscriptionModel) {
                        installTranscriptionModel.mutate(installableTranscriptionModel);
                      }
                    }}
                    retryModels={() => void analysisModelsQuery.refetch()}
                    language={transcriptionLanguage}
                    setLanguage={setTranscriptionLanguage}
                    cloudConfigured={cloudLearningReady}
                    cloudPending={cloudLearningQuery.isPending}
                    cloudError={cloudLearningQuery.isError}
                    retryCloud={() => void cloudLearningQuery.refetch()}
                    transcriptionProgress={transcriptionProgress}
                    transcriptionPending={transcribeLecture.isPending}
                    startTranscript={() => transcribeLecture.mutate()}
                    consent={learningConsent}
                  />

                  <label
                    className={cn(
                      'flex items-start gap-3 rounded-xl border bg-secondary/35 p-3 text-sm',
                      learningReady ? 'cursor-pointer' : 'cursor-not-allowed opacity-60',
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={learningConsent}
                      disabled={!learningReady}
                      onChange={(event) => setLearningConsent(event.target.checked)}
                      className="mt-0.5 size-4 accent-primary"
                    />
                    <span>
                      Allow grounded AI requests for this lecture during this open study session.
                      Requests send only the transcript context they need and, for frame notes, the
                      captured frame. Nothing is committed to a plan automatically.
                    </span>
                  </label>

                  <div className="flex flex-wrap gap-2">
                    <Button
                      disabled={!learningReady || !learningConsent || generateLecture.isPending}
                      onClick={() => generateLecture.mutate()}
                    >
                      {generateLecture.isPending ? (
                        <LoaderCircle className="size-4 animate-spin" />
                      ) : (
                        <BookOpen className="size-4" />
                      )}
                      {lectureQuery.data ? 'Regenerate lecture analysis' : 'Analyze this lecture'}
                    </Button>
                    <Button
                      variant="outline"
                      disabled={
                        !learningReady ||
                        !learningConsent ||
                        createFrameNote.isPending ||
                        phase !== 'ready'
                      }
                      onClick={() => createFrameNote.mutate()}
                    >
                      {createFrameNote.isPending ? (
                        <LoaderCircle className="size-4 animate-spin" />
                      ) : (
                        <Camera className="size-4" />
                      )}
                      Explain this frame and save note
                    </Button>
                    <Button
                      variant="outline"
                      disabled={!learningReady || !learningConsent || generateMaterials.isPending}
                      onClick={() => generateMaterials.mutate()}
                    >
                      {generateMaterials.isPending ? (
                        <LoaderCircle className="size-4 animate-spin" />
                      ) : (
                        <Brain className="size-4" />
                      )}
                      {studyQuery.data?.length ? 'Regenerate study set' : 'Generate study set'}
                    </Button>
                  </div>

                  <section
                    className="rounded-xl border bg-background p-4"
                    aria-labelledby="companion-heading"
                  >
                    <div className="flex items-start gap-3">
                      <MessageCircle className="mt-0.5 size-4 shrink-0 text-primary" />
                      <div>
                        <h3 id="companion-heading" className="text-sm font-semibold">
                          Grounded study companion
                        </h3>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Only a narrow transcript window around {formatTimestamp(view.position_ms)}{' '}
                          is sent for each action.
                        </p>
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {companionActions.map((item) => (
                        <Button
                          key={item.action}
                          size="sm"
                          variant="secondary"
                          disabled={!learningReady || !learningConsent || companion.isPending}
                          onClick={() => companion.mutate(item.action)}
                        >
                          {item.label}
                        </Button>
                      ))}
                    </div>
                    {companion.isPending ? (
                      <p
                        className="mt-3 flex items-center gap-2 text-sm text-muted-foreground"
                        role="status"
                      >
                        <LoaderCircle className="size-4 animate-spin" /> Reading the nearby
                        transcript…
                      </p>
                    ) : null}
                    {companion.data && companionResultMediaId === view.media_id ? (
                      <div className="mt-4 rounded-lg bg-secondary/45 p-4">
                        <p className="whitespace-pre-wrap text-sm leading-7">
                          {companion.data.answer_markdown}
                        </p>
                        <EvidenceButtons
                          label="Companion evidence"
                          evidence={companion.data.evidence}
                          onSeek={(atMs) => void commitSeek(atMs)}
                        />
                      </div>
                    ) : null}
                  </section>

                  {learningStatus ? (
                    <p className="rounded-lg border bg-background p-3 text-sm" role="status">
                      {learningStatus}
                    </p>
                  ) : null}
                  {learningError ? (
                    <div
                      className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
                      role="alert"
                    >
                      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                      <span>{learningError}</span>
                    </div>
                  ) : null}
                  {lectureQuery.isError ? (
                    <div
                      className="flex flex-wrap items-center justify-between gap-3 text-sm text-destructive"
                      role="alert"
                    >
                      <span>{messageFrom(lectureQuery.error)}</span>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void lectureQuery.refetch()}
                      >
                        Reload analysis
                      </Button>
                    </div>
                  ) : null}
                  {notesQuery.isError || studyQuery.isError ? (
                    <div
                      className="flex flex-wrap items-center justify-between gap-3 text-sm text-destructive"
                      role="alert"
                    >
                      <span>Saved learning materials could not be loaded.</span>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          if (notesQuery.isError) void notesQuery.refetch();
                          if (studyQuery.isError) void studyQuery.refetch();
                        }}
                      >
                        Reload materials
                      </Button>
                    </div>
                  ) : null}

                  {lectureQuery.data ? (
                    <div className="grid gap-5 lg:grid-cols-2">
                      <section className="space-y-3" aria-labelledby="lecture-summary-heading">
                        <h3 id="lecture-summary-heading" className="font-display font-semibold">
                          Summary
                        </h3>
                        <p className="text-sm leading-7 text-muted-foreground">
                          {lectureQuery.data.summary.text}
                        </p>
                        <EvidenceButtons
                          label="Summary evidence"
                          evidence={lectureQuery.data.summary.evidence}
                          onSeek={(atMs) => void commitSeek(atMs)}
                        />
                        {lectureQuery.data.learning_objectives.length > 0 ? (
                          <div>
                            <h4 className="text-sm font-semibold">Learning objectives</h4>
                            <ul className="mt-2 space-y-2 text-sm text-muted-foreground">
                              {lectureQuery.data.learning_objectives.map((objective, index) => (
                                <li key={`${objective.text}-${index}`} className="flex gap-2">
                                  <span aria-hidden="true">•</span>
                                  <button
                                    type="button"
                                    className="text-left leading-6 hover:text-foreground hover:underline"
                                    onClick={() => void commitSeek(objective.evidence[0].start_ms)}
                                  >
                                    {objective.text}
                                  </button>
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                      </section>

                      <section className="space-y-3" aria-labelledby="lecture-chapters-heading">
                        <div className="flex items-center justify-between gap-3">
                          <h3 id="lecture-chapters-heading" className="font-display font-semibold">
                            Timestamped chapters
                          </h3>
                          <Badge tone="neutral">
                            {lectureQuery.data.difficulty.level} difficulty ·{' '}
                            {lectureQuery.data.difficulty.confidence} confidence
                          </Badge>
                        </div>
                        <div className="max-h-72 space-y-2 overflow-auto pr-1">
                          {lectureQuery.data.chapters.map((chapter) => (
                            <button
                              key={`${chapter.start_ms}-${chapter.title}`}
                              type="button"
                              className="block w-full rounded-lg border bg-background p-3 text-left transition-colors hover:border-primary/35 hover:bg-accent/30"
                              onClick={() => void commitSeek(chapter.start_ms)}
                            >
                              <span className="font-mono text-xs text-primary">
                                {formatTimestamp(chapter.start_ms)}
                              </span>
                              <span className="ml-2 text-sm font-semibold">{chapter.title}</span>
                              <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                                {chapter.summary}
                              </span>
                            </button>
                          ))}
                        </div>
                      </section>

                      {lectureQuery.data.concepts.length > 0 ? (
                        <section
                          className="space-y-3 lg:col-span-2"
                          aria-labelledby="concepts-heading"
                        >
                          <h3 id="concepts-heading" className="font-display font-semibold">
                            Concepts and definitions
                          </h3>
                          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                            {lectureQuery.data.concepts.map((concept) => (
                              <button
                                key={concept.name}
                                type="button"
                                className="rounded-lg border bg-background p-3 text-left hover:border-primary/35"
                                onClick={() => void commitSeek(concept.evidence[0].start_ms)}
                              >
                                <span className="text-sm font-semibold">{concept.name}</span>
                                <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                                  {concept.definition}
                                </span>
                                <span className="mt-2 block font-mono text-[11px] text-primary">
                                  Open at {formatTimestamp(concept.evidence[0].start_ms)}
                                </span>
                              </button>
                            ))}
                          </div>
                        </section>
                      ) : null}
                    </div>
                  ) : null}

                  {notesQuery.data && notesQuery.data.length > 0 ? (
                    <section
                      className="space-y-3 border-t pt-5"
                      aria-labelledby="frame-notes-heading"
                    >
                      <h3 id="frame-notes-heading" className="font-display font-semibold">
                        Saved frame explanations
                      </h3>
                      <div className="grid gap-3 lg:grid-cols-2">
                        {notesQuery.data.map((note) => (
                          <article key={note.id} className="rounded-xl border bg-background p-4">
                            <button
                              type="button"
                              className="font-semibold hover:text-primary hover:underline"
                              onClick={() => void commitSeek(note.at_ms)}
                            >
                              {formatTimestamp(note.at_ms)} · {note.title}
                            </button>
                            <StudyNoteBody markdown={note.body_markdown} />
                            {note.evidence.length > 0 ? (
                              <div className="mt-3">
                                <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
                                  Cited moments
                                </p>
                                <EvidenceButtons
                                  label={`Evidence for ${note.title}`}
                                  evidence={note.evidence}
                                  onSeek={(atMs) => void commitSeek(atMs)}
                                />
                              </div>
                            ) : null}
                            <p className="mt-3 font-mono text-[11px] text-muted-foreground">
                              {note.frame_grounded
                                ? 'Frame + transcript grounded'
                                : 'Transcript grounded'}
                              {' · '}
                              {note.model}
                            </p>
                          </article>
                        ))}
                      </div>
                    </section>
                  ) : null}

                  {studyQuery.data && studyQuery.data.length > 0 ? (
                    <section
                      className="space-y-3 border-t pt-5"
                      aria-labelledby="study-materials-heading"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <h3 id="study-materials-heading" className="font-display font-semibold">
                            Study materials
                          </h3>
                          <p className="mt-1 text-xs text-muted-foreground">
                            AI creates the questions; deterministic SM-2 schedules every review.
                          </p>
                        </div>
                        <Badge tone="neutral">{studyQuery.data.length} items</Badge>
                      </div>
                      <div className="grid gap-3 lg:grid-cols-2">
                        {studyQuery.data.map((item) => {
                          const revealed = revealedStudyItem === item.id;
                          return (
                            <article key={item.id} className="rounded-xl border bg-background p-4">
                              <div className="flex items-center justify-between gap-3">
                                <Badge tone="primary">{studyKindLabel(item.kind)}</Badge>
                                <button
                                  type="button"
                                  className="font-mono text-[11px] text-primary hover:underline"
                                  onClick={() => void commitSeek(item.evidence[0].start_ms)}
                                >
                                  Evidence {formatTimestamp(item.evidence[0].start_ms)}
                                </button>
                              </div>
                              <p className="mt-3 text-sm font-medium leading-6">{item.prompt}</p>
                              {item.options.length > 0 ? (
                                <ol className="mt-2 list-inside list-[upper-alpha] space-y-1 text-sm text-muted-foreground">
                                  {item.options.map((option) => (
                                    <li key={option}>{option}</li>
                                  ))}
                                </ol>
                              ) : null}
                              {item.hint ? (
                                <p className="mt-2 text-xs text-muted-foreground">
                                  Hint: {item.hint}
                                </p>
                              ) : null}
                              {!revealed ? (
                                <Button
                                  className="mt-3"
                                  size="sm"
                                  variant="outline"
                                  onClick={() => revealStudyAnswer(item.id)}
                                >
                                  Reveal answer
                                </Button>
                              ) : (
                                <div className="mt-3 rounded-lg bg-secondary/55 p-3">
                                  <p className="text-sm leading-6">{item.answer}</p>
                                  <div className="mt-3 flex flex-wrap items-end gap-2">
                                    <label className="text-xs font-medium">
                                      Confidence
                                      <select
                                        className="ml-2 h-8 rounded-md border bg-background px-2"
                                        value={reviewConfidence}
                                        onChange={(event) =>
                                          setReviewConfidence(Number(event.target.value))
                                        }
                                      >
                                        {[1, 2, 3, 4, 5].map((value) => (
                                          <option key={value} value={value}>
                                            {value}
                                          </option>
                                        ))}
                                      </select>
                                    </label>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      disabled={submitReview.isPending}
                                      onClick={() => submitReview.mutate({ item, quality: 1 })}
                                    >
                                      Again
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="secondary"
                                      disabled={submitReview.isPending}
                                      onClick={() => submitReview.mutate({ item, quality: 3 })}
                                    >
                                      Hard
                                    </Button>
                                    <Button
                                      size="sm"
                                      disabled={submitReview.isPending}
                                      onClick={() => submitReview.mutate({ item, quality: 5 })}
                                    >
                                      Easy
                                    </Button>
                                  </div>
                                </div>
                              )}
                              <p className="mt-3 font-mono text-[11px] text-muted-foreground">
                                Due {formatReviewDate(item.due_at)} · interval {item.interval_days}d
                                · {item.repetitions} successful reviews
                              </p>
                            </article>
                          );
                        })}
                      </div>
                    </section>
                  ) : null}
                </CardContent>
              ) : null}
            </Card>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function LearningSetup({
  transcriptStatus,
  transcriptSegments,
  transcriptLanguage,
  transcriptModelId,
  transcriptPending,
  transcriptError,
  retryTranscript,
  capability,
  capabilityPending,
  capabilityError,
  retryCapability,
  modelPending,
  modelError,
  hasReadyModel,
  installableModel,
  modelInstallProgress,
  modelInstallPending,
  installSelectedModel,
  retryModels,
  language,
  setLanguage,
  cloudConfigured,
  cloudPending,
  cloudError,
  retryCloud,
  transcriptionProgress,
  transcriptionPending,
  startTranscript,
  consent,
}: {
  transcriptStatus?: 'not_started' | 'queued' | 'processing' | 'attention' | 'completed' | 'failed';
  transcriptSegments: number;
  transcriptLanguage: string | null;
  transcriptModelId: string | null;
  transcriptPending: boolean;
  transcriptError: boolean;
  retryTranscript: () => void;
  capability?: AnalysisCapability;
  capabilityPending: boolean;
  capabilityError: boolean;
  retryCapability: () => void;
  modelPending: boolean;
  modelError: boolean;
  hasReadyModel: boolean;
  installableModel?: LocalModel;
  modelInstallProgress?: AnalysisProgress;
  modelInstallPending: boolean;
  installSelectedModel: () => void;
  retryModels: () => void;
  language: TranscriptionLanguage;
  setLanguage: (language: TranscriptionLanguage) => void;
  cloudConfigured: boolean;
  cloudPending: boolean;
  cloudError: boolean;
  retryCloud: () => void;
  transcriptionProgress?: AnalysisProgress;
  transcriptionPending: boolean;
  startTranscript: () => void;
  consent: boolean;
}) {
  const transcriptReady = transcriptStatus === 'completed';
  const transcriptActive = isTranscriptActive(transcriptStatus);
  const engineReady = capability?.available === true;
  const languageSupported = capability?.supported_languages.includes(language) === true;
  const transcriptionActive =
    transcriptionPending ||
    transcriptActive ||
    isTranscriptionProgressActive(transcriptionProgress);
  const modelInstallActive =
    modelInstallPending ||
    installableModel?.state === 'downloading' ||
    isModelInstallProgressActive(modelInstallProgress);
  const localSetupActive = transcriptionActive || modelInstallActive;
  return (
    <section className="space-y-3" aria-labelledby="toolkit-readiness-heading">
      <div>
        <h3 id="toolkit-readiness-heading" className="text-sm font-semibold">
          Toolkit readiness
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Grounded answers require these local and cloud prerequisites.
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <ReadinessItem
          label="Local engine"
          value={
            capabilityPending
              ? 'Checking…'
              : capabilityError
                ? 'Status unavailable'
                : engineReady
                  ? `${capability?.engine ?? 'Whisper'} ready`
                  : 'Setup needed'
          }
          ready={engineReady}
          pending={capabilityPending}
        />
        <ReadinessItem
          label="Local transcript"
          value={transcriptReadinessLabel(
            transcriptStatus,
            transcriptSegments,
            transcriptLanguage,
            transcriptPending,
            transcriptError,
          )}
          ready={transcriptReady}
          pending={transcriptPending || transcriptActive}
        />
        <ReadinessItem
          label="OpenRouter"
          value={
            cloudPending
              ? 'Checking…'
              : cloudError
                ? 'Unavailable'
                : cloudConfigured
                  ? 'Connected'
                  : 'Not configured'
          }
          ready={cloudConfigured}
          pending={cloudPending}
        />
        <ReadinessItem
          label="Session consent"
          value={consent ? 'Approved' : 'Waiting for you'}
          ready={consent}
          pending={false}
        />
      </div>

      <fieldset
        className="rounded-xl border border-border/70 bg-background/60 p-4"
        disabled={localSetupActive}
      >
        <legend className="px-1 text-xs font-semibold">Transcript language</legend>
        <p className="text-xs leading-5 text-muted-foreground">
          {transcriptReady
            ? `Current transcript: ${transcriptLanguage ? transcriptionLanguageDisplay(transcriptLanguage) : 'language not recorded'}. Choose a language below to replace it.`
            : 'Choose the spoken language so local transcription and grounded study content use the right language.'}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {(['en', 'bn'] as const).map((option) => (
            <label
              key={option}
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded-lg border bg-background px-3 py-2 text-xs font-medium',
                language === option && 'border-primary bg-primary/[0.06] text-primary',
                localSetupActive && 'cursor-not-allowed opacity-60',
              )}
            >
              <input
                type="radio"
                name="transcription-language"
                value={option}
                checked={language === option}
                onChange={() => setLanguage(option)}
                className="size-3.5 accent-primary"
              />
              {transcriptionLanguageDisplay(option)}
            </label>
          ))}
        </div>
      </fieldset>

      {transcriptReady ? (
        <div className="rounded-xl border border-success/25 bg-success/[0.06] p-4">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">
                {transcriptLanguage
                  ? `${transcriptionLanguageDisplay(transcriptLanguage)} transcript ready`
                  : 'Local transcript ready'}
              </p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {transcriptSegments} cited segments
                {transcriptModelId ? ` · ${transcriptModelId}` : ''}. Retranscribing creates a new
                active transcript without deleting prior study history.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {capabilityError ? (
                  <Button size="sm" variant="outline" onClick={retryCapability}>
                    <RefreshCcw className="size-3.5" /> Check local engine again
                  </Button>
                ) : capabilityPending ? (
                  <Button size="sm" variant="outline" disabled>
                    <LoaderCircle className="size-3.5 animate-spin" /> Checking local engine…
                  </Button>
                ) : !engineReady ? (
                  <Link className={settingsLinkClass} to="/settings">
                    Open transcription settings
                  </Link>
                ) : !languageSupported ? (
                  <Link className={settingsLinkClass} to="/settings">
                    Set up {transcriptionLanguageLabel(language)} transcription
                  </Link>
                ) : modelError ? (
                  <Button size="sm" variant="outline" onClick={retryModels}>
                    <RefreshCcw className="size-3.5" /> Check models again
                  </Button>
                ) : modelPending ? (
                  <Button size="sm" variant="outline" disabled>
                    <LoaderCircle className="size-3.5 animate-spin" /> Checking models…
                  </Button>
                ) : !hasReadyModel && installableModel ? (
                  <ModelInstallControl
                    model={installableModel}
                    progress={modelInstallProgress}
                    pending={modelInstallPending}
                    onInstall={installSelectedModel}
                  />
                ) : !hasReadyModel ? (
                  <Link className={settingsLinkClass} to="/settings">
                    Review {transcriptionLanguageLabel(language)} transcription models
                  </Link>
                ) : (
                  <Button size="sm" disabled={transcriptionActive} onClick={startTranscript}>
                    {transcriptionActive ? (
                      <LoaderCircle className="size-3.5 animate-spin" />
                    ) : (
                      <RefreshCcw className="size-3.5" />
                    )}
                    {transcriptionActive
                      ? transcriptionActionLabel(
                          transcriptionProgress,
                          transcriptStatus,
                          transcriptionPending,
                        )
                      : `Retranscribe in ${transcriptionLanguageLabel(language)}`}
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {!transcriptReady ? (
        <div className="rounded-xl border border-warning/25 bg-warning/[0.07] p-4">
          <div className="flex items-start gap-3">
            <Captions className="mt-0.5 size-5 shrink-0 text-warning" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">
                {capability && !engineReady
                  ? 'Local transcription engine unavailable'
                  : 'Prepare a local transcript first'}
              </p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {capability && !engineReady
                  ? capability.message
                  : 'LectorBit transcribes this lecture on-device. The transcript unlocks cited explanations, frame notes, chapter navigation, and review cards.'}
              </p>
              {capability && !engineReady ? (
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  {analysisCapabilityHelp(capability.unavailable_reason)}
                </p>
              ) : null}

              <div className="mt-3 flex flex-wrap gap-2">
                {transcriptError ? (
                  <Button size="sm" variant="outline" onClick={retryTranscript}>
                    <RefreshCcw className="size-3.5" /> Check transcript again
                  </Button>
                ) : capabilityError ? (
                  <Button size="sm" variant="outline" onClick={retryCapability}>
                    <RefreshCcw className="size-3.5" /> Check local engine again
                  </Button>
                ) : capabilityPending || transcriptPending ? (
                  <Button size="sm" variant="outline" disabled>
                    <LoaderCircle className="size-3.5 animate-spin" /> Checking local setup…
                  </Button>
                ) : !engineReady ? (
                  <>
                    <Link className={settingsLinkClass} to="/settings">
                      Open transcription settings
                    </Link>
                    <Button size="sm" variant="outline" onClick={retryCapability}>
                      <RefreshCcw className="size-3.5" /> Check again
                    </Button>
                  </>
                ) : !languageSupported ? (
                  <Link className={settingsLinkClass} to="/settings">
                    Set up {transcriptionLanguageLabel(language)} transcription
                  </Link>
                ) : modelError ? (
                  <Button size="sm" variant="outline" onClick={retryModels}>
                    <RefreshCcw className="size-3.5" /> Check models again
                  </Button>
                ) : modelPending ? (
                  <Button size="sm" variant="outline" disabled>
                    <LoaderCircle className="size-3.5 animate-spin" /> Checking models…
                  </Button>
                ) : !hasReadyModel && installableModel ? (
                  <ModelInstallControl
                    model={installableModel}
                    progress={modelInstallProgress}
                    pending={modelInstallPending}
                    onInstall={installSelectedModel}
                  />
                ) : !hasReadyModel ? (
                  <Link className={settingsLinkClass} to="/settings">
                    Review {transcriptionLanguageLabel(language)} transcription models
                  </Link>
                ) : (
                  <Button size="sm" disabled={transcriptionActive} onClick={startTranscript}>
                    {transcriptionActive ? (
                      <LoaderCircle className="size-3.5 animate-spin" />
                    ) : (
                      <Captions className="size-3.5" />
                    )}
                    {transcriptionActionLabel(
                      transcriptionProgress,
                      transcriptStatus,
                      transcriptionPending,
                    )}
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {!cloudPending && !cloudConfigured ? (
        <div className="flex flex-col gap-3 rounded-xl border border-primary/15 bg-primary/[0.04] p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold">
              {cloudError ? 'OpenRouter status is unavailable' : 'Connect OpenRouter'}
            </p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Your protected API key powers the optional grounded learning requests.
            </p>
          </div>
          {cloudError ? (
            <Button className="shrink-0" size="sm" variant="outline" onClick={retryCloud}>
              Check again
            </Button>
          ) : (
            <Link className={cn(settingsLinkClass, 'shrink-0')} to="/settings">
              Open AI settings
            </Link>
          )}
        </div>
      ) : null}
    </section>
  );
}

function ModelInstallControl({
  model,
  progress,
  pending,
  onInstall,
}: {
  model: LocalModel;
  progress?: AnalysisProgress;
  pending: boolean;
  onInstall: () => void;
}) {
  const active = pending || model.state === 'downloading' || isModelInstallProgressActive(progress);
  const percentage = modelInstallPercentage(model, progress);
  const coverage = modelCoverageLabel(model);
  const failed = model.state === 'failed' || progress?.event === 'failed';
  return (
    <div className="min-w-[15rem] space-y-2">
      <Button size="sm" disabled={active} onClick={onInstall}>
        {active ? (
          <LoaderCircle className="size-3.5 animate-spin" />
        ) : (
          <Download className="size-3.5" />
        )}
        {active ? `Installing ${coverage}…` : failed ? `Retry ${coverage}` : `Install ${coverage}`}
      </Button>
      <p className="text-xs leading-5 text-muted-foreground" aria-live="polite">
        {modelInstallStatus(model, progress, percentage)}
      </p>
      {percentage !== undefined && active ? (
        <div
          className="h-1.5 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label="Transcription model download"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percentage}
        >
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-200 motion-reduce:transition-none"
            style={{ width: `${percentage}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}

function ReadinessItem({
  label,
  value,
  ready,
  pending,
}: {
  label: string;
  value: string;
  ready: boolean;
  pending: boolean;
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-border/70 bg-background/60 p-3">
      <span
        className={cn(
          'grid size-7 shrink-0 place-items-center rounded-full',
          ready
            ? 'bg-success/15 text-success'
            : pending
              ? 'bg-primary/10 text-primary'
              : 'bg-muted text-muted-foreground',
        )}
      >
        {ready ? (
          <CheckCircle2 className="size-4" />
        ) : pending ? (
          <LoaderCircle className="size-4 animate-spin" />
        ) : (
          <span className="size-2 rounded-full bg-current" />
        )}
      </span>
      <span className="min-w-0">
        <span className="block text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
          {label}
        </span>
        <span className="mt-0.5 block truncate text-sm font-medium">{value}</span>
      </span>
    </div>
  );
}

function ShortcutGuide() {
  const shortcuts = [
    ['Space / K', 'Play or pause'],
    ['← / →', 'Seek 10 seconds'],
    ['F', 'Toggle focus mode'],
    ['Esc', 'Exit focus mode'],
  ];
  return (
    <div
      className="mb-5 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-primary/15 bg-primary/[0.04] px-4 py-3 text-xs"
      role="region"
      aria-label="Keyboard shortcuts"
    >
      <span className="flex items-center gap-2 font-semibold">
        <Keyboard className="size-4 text-primary" /> Keyboard controls
      </span>
      {shortcuts.map(([keys, label]) => (
        <span key={keys} className="flex items-center gap-2 text-muted-foreground">
          <kbd className="rounded-md border bg-background px-2 py-1 font-mono text-[11px] text-foreground shadow-sm">
            {keys}
          </kbd>
          {label}
        </span>
      ))}
    </div>
  );
}

function SessionMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/70 bg-background/60 p-3">
      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 font-display text-xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function LearningTrail({
  markers,
  draft,
  status,
  error,
  loading,
  pending,
  onDraftChange,
  onSave,
  onSeek,
  onToggleReviewed,
  onRemove,
}: {
  markers: LearningMarker[];
  draft: string;
  status?: string;
  error?: string;
  loading: boolean;
  pending: boolean;
  onDraftChange: (value: string) => void;
  onSave: (kind: LearningMarkerKind) => void;
  onSeek: (atMs: number) => void;
  onToggleReviewed: (markerId: string) => void;
  onRemove: (markerId: string) => void;
}) {
  const openCount = markers.filter((marker) => !marker.reviewed).length;
  const canSave = draft.trim().length > 0;
  return (
    <Card className="overflow-hidden border-primary/15">
      <CardHeader className="border-b border-border/70 bg-primary/[0.035]">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Flag className="size-4 text-primary" /> Learning trail
            </CardTitle>
            <CardDescription className="mt-1">
              Pin a question or takeaway to this exact moment. It stays on this device and is
              searchable across LectorBit.
            </CardDescription>
          </div>
          <Badge tone={openCount > 0 ? 'warning' : 'neutral'}>{openCount} open</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 pt-5">
        <div>
          <label className="text-sm font-semibold" htmlFor="learning-marker-note">
            What should future-you remember?
          </label>
          <textarea
            id="learning-marker-note"
            rows={2}
            maxLength={MAX_LEARNING_MARKER_LENGTH}
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            placeholder="A question, misconception, or key connection…"
            className="mt-2 w-full resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm leading-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!canSave || pending}
              onClick={() => onSave('question')}
            >
              Save question
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={!canSave || pending}
              onClick={() => onSave('takeaway')}
            >
              Save takeaway
            </Button>
          </div>
        </div>

        {status ? (
          <p className="text-xs leading-5 text-success" role="status">
            {status}
          </p>
        ) : null}

        {error ? (
          <p className="text-xs leading-5 text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        {loading ? (
          <p className="rounded-lg border border-dashed p-3 text-xs leading-5 text-muted-foreground">
            Loading your private learning trail…
          </p>
        ) : markers.length === 0 ? (
          <p className="rounded-lg border border-dashed p-3 text-xs leading-5 text-muted-foreground">
            No markers yet. Capture uncertainty while it is fresh, then return here before ending
            the lecture.
          </p>
        ) : (
          <div
            className="max-h-80 space-y-2 overflow-auto pr-1"
            aria-label="Saved learning markers"
          >
            {markers.map((marker) => (
              <article
                key={marker.id}
                className={cn(
                  'rounded-lg border bg-background p-3',
                  marker.reviewed && 'opacity-65',
                )}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Badge
                    tone={
                      marker.reviewed
                        ? 'success'
                        : marker.kind === 'question'
                          ? 'warning'
                          : 'primary'
                    }
                  >
                    {marker.reviewed ? 'Reviewed' : learningMarkerLabel(marker.kind)}
                  </Badge>
                  <button
                    type="button"
                    className="font-mono text-[11px] font-semibold text-primary hover:underline"
                    onClick={() => onSeek(marker.at_ms)}
                  >
                    Replay {formatTimestamp(marker.at_ms)}
                  </button>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-6">{marker.text}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => onToggleReviewed(marker.id)}
                  >
                    {marker.reviewed
                      ? 'Reopen'
                      : marker.kind === 'question'
                        ? 'Mark understood'
                        : 'Mark reviewed'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => onRemove(marker.id)}
                  >
                    Remove
                  </Button>
                </div>
              </article>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StudyActions({
  actionsDisabled,
  view,
  confirmSkip,
  setConfirmSkip,
  performAction,
  busy,
  actionPending,
  replanPending,
  replanRemaining,
  actionMessage,
}: {
  actionsDisabled: boolean;
  view: PlaybackView;
  confirmSkip: boolean;
  setConfirmSkip: (value: boolean) => void;
  performAction: (kind: StudyAction) => Promise<void>;
  busy: boolean;
  actionPending: StudyAction | undefined;
  replanPending: boolean;
  replanRemaining: () => Promise<void>;
  actionMessage: string | undefined;
}) {
  return (
    <Card className="overflow-hidden">
      <CardHeader className="border-b border-border/70 bg-muted/15">
        <CardTitle>Finish the session</CardTitle>
        <CardDescription>
          Save an outcome now. Your next routine will adapt without rewriting history.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 pt-5">
        <Button
          className="w-full"
          disabled={actionsDisabled || view.completed}
          onClick={() => void performAction('complete')}
        >
          <CheckCircle2 className="size-4" /> Mark complete
        </Button>
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="outline"
            disabled={actionsDisabled}
            onClick={() => void performAction('postpone')}
          >
            <Clock3 className="size-4" /> Postpone
          </Button>
          <Button
            variant="outline"
            disabled={
              actionsDisabled ||
              view.position_ms <= view.raw_start_ms ||
              view.position_ms >= view.raw_end_ms
            }
            onClick={() => void performAction('split')}
          >
            <Scissors className="size-4" /> Split here
          </Button>
          <Button
            variant="outline"
            disabled={actionsDisabled}
            onClick={() => void performAction('repeat')}
          >
            <RefreshCcw className="size-4" /> Repeat
          </Button>
          <Button
            variant="outline"
            disabled={actionsDisabled}
            onClick={() => void performAction('must_watch')}
          >
            <Flag className="size-4" /> Must watch
          </Button>
        </div>
        <div className="border-t border-border/70 pt-3">
          {confirmSkip ? (
            <div className="grid grid-cols-2 gap-2 rounded-lg border border-destructive/20 bg-destructive/[0.04] p-2">
              <Button
                variant="destructive"
                disabled={actionsDisabled}
                onClick={() => void performAction('skip')}
              >
                Confirm skip
              </Button>
              <Button
                variant="ghost"
                onClick={() => setConfirmSkip(false)}
                disabled={actionsDisabled}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              className="w-full"
              variant="ghost"
              aria-label="Skip"
              disabled={actionsDisabled}
              onClick={() => setConfirmSkip(true)}
            >
              Skip this block
            </Button>
          )}
          <Button
            className="mt-2 w-full"
            variant="secondary"
            disabled={busy || Boolean(actionPending) || replanPending}
            onClick={() => void replanRemaining()}
          >
            <RefreshCcw className="size-4" />
            {replanPending ? 'Replanning…' : 'Replan remaining'}
          </Button>
        </div>
        {actionMessage ? (
          <p className="flex items-center gap-2 text-sm text-success" role="status">
            <CheckCircle2 className="size-4" /> {actionMessage}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function EvidenceButtons({
  label,
  evidence,
  onSeek,
}: {
  label: string;
  evidence: Array<{ segment_id: number; start_ms: number; end_ms: number }>;
  onSeek: (atMs: number) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" aria-label={label} role="group">
      {evidence.map((item) => (
        <button
          key={item.segment_id}
          type="button"
          className="rounded-md bg-secondary px-2 py-1 font-mono text-[11px] text-secondary-foreground hover:bg-accent"
          onClick={() => onSeek(item.start_ms)}
        >
          {formatTimestamp(item.start_ms)}
        </button>
      ))}
    </div>
  );
}

function StudyNoteBody({ markdown }: { markdown: string }) {
  const lines = markdown.split(/\r?\n/);
  return (
    <div className="mt-3 space-y-2 text-sm leading-6 text-muted-foreground">
      {lines.map((rawLine, index) => {
        const line = rawLine.trim();
        if (!line) return <div key={`space-${index}`} className="h-1" aria-hidden="true" />;
        const heading = /^(#{1,3})\s+(.+)$/.exec(line);
        if (heading) {
          return (
            <h4 key={`heading-${index}`} className="pt-1 font-semibold text-foreground">
              {plainStudyText(heading[2])}
            </h4>
          );
        }
        const bullet = /^[-*]\s+(.+)$/.exec(line);
        if (bullet) {
          return (
            <p key={`bullet-${index}`} className="flex gap-2 pl-1">
              <span className="text-primary" aria-hidden="true">
                •
              </span>
              <span>{plainStudyText(bullet[1])}</span>
            </p>
          );
        }
        const numbered = /^(\d+)[.)]\s+(.+)$/.exec(line);
        if (numbered) {
          return (
            <p key={`numbered-${index}`} className="flex gap-2 pl-1">
              <span className="font-mono text-xs text-primary">{numbered[1]}.</span>
              <span>{plainStudyText(numbered[2])}</span>
            </p>
          );
        }
        return <p key={`paragraph-${index}`}>{plainStudyText(line)}</p>;
      })}
    </div>
  );
}

function captureVideoFrame(video: HTMLVideoElement): string {
  if (
    !video.videoWidth ||
    !video.videoHeight ||
    video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
  ) {
    throw new Error('Wait until the current video frame is visible.');
  }
  const maxWidth = 960;
  const scale = Math.min(1, maxWidth / video.videoWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This WebView cannot capture the current frame.');
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.72);
  if (!dataUrl.startsWith('data:image/jpeg;base64,')) {
    throw new Error('The current frame could not be encoded safely.');
  }
  return dataUrl;
}

function studyKindLabel(kind: StudyItem['kind']): string {
  return {
    flashcard: 'Flashcard',
    multiple_choice: 'Multiple choice',
    short_answer: 'Short answer',
    explain_own_words: 'Explain it',
  }[kind];
}

function formatReviewDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'now';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(parsed);
}

function PlaybackBadge({ view, phase }: { view: PlaybackView; phase: Phase }) {
  if (phase === 'closed')
    return (
      <Badge>
        <Square className="size-3" /> Closed
      </Badge>
    );
  if (view.completed)
    return (
      <Badge tone="success">
        <CheckCircle2 className="size-3" /> Completed
      </Badge>
    );
  return view.paused ? (
    <Badge>
      <Pause className="size-3" /> Paused
    </Badge>
  ) : (
    <Badge tone="primary">
      <Play className="size-3" /> Playing
    </Badge>
  );
}

function PlayerSkeleton() {
  return (
    <div
      className="grid gap-4 min-[1320px]:grid-cols-[minmax(0,1.5fr)_minmax(18rem,0.5fr)]"
      aria-label="Loading player"
    >
      <div className="h-72 animate-pulse rounded-lg border bg-card motion-reduce:animate-none" />
      <div className="h-72 animate-pulse rounded-lg border bg-card motion-reduce:animate-none" />
    </div>
  );
}

function clampPosition(view: PlaybackView): number {
  return Math.max(view.raw_start_ms, Math.min(view.raw_end_ms, view.position_ms));
}

function enforceBlockBounds(video: HTMLVideoElement, view: PlaybackView): number {
  const rawPosition = Math.round(video.currentTime * 1_000);
  const position = Math.max(view.raw_start_ms, Math.min(view.raw_end_ms, rawPosition));
  if (position !== rawPosition) video.currentTime = position / 1_000;
  return position;
}

function formatTimestamp(milliseconds: number): string {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder].map((part) => String(part).padStart(2, '0')).join(':');
}

function formatDuration(milliseconds: number): string {
  const minutes = Math.max(0, Math.round(milliseconds / 60_000));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function isTranscriptActive(status?: string): boolean {
  return status === 'queued' || status === 'processing' || status === 'attention';
}

function isTranscriptionProgressActive(progress?: AnalysisProgress): boolean {
  return (
    progress !== undefined &&
    ['queued', 'extracting', 'transcribing', 'indexing'].includes(progress.event)
  );
}

function isModelInstallProgressActive(progress?: AnalysisProgress): boolean {
  return progress !== undefined && ['queued', 'downloading'].includes(progress.event);
}

function selectTranscriptionModel(
  models: LocalModel[] | undefined,
  language: TranscriptionLanguage,
  state: 'ready' | 'installable',
): LocalModel | undefined {
  return models
    ?.filter(
      (model) =>
        model.supported_languages.includes(language) &&
        (state === 'ready' ? model.state === 'ready' : model.state !== 'ready'),
    )
    .sort((left, right) => {
      const coverageDifference = right.supported_languages.length - left.supported_languages.length;
      if (coverageDifference !== 0) return coverageDifference;
      if (left.state === 'downloading' && right.state !== 'downloading') return -1;
      if (right.state === 'downloading' && left.state !== 'downloading') return 1;
      return left.id.localeCompare(right.id);
    })[0];
}

function modelInstallPercentage(
  model: LocalModel,
  progress: AnalysisProgress | undefined,
): number | undefined {
  if (progress?.event === 'downloading') {
    return Math.min(
      100,
      Math.round((progress.data.downloadedBytes / progress.data.totalBytes) * 100),
    );
  }
  if (model.state === 'downloading' && model.expected_size_bytes > 0) {
    return Math.min(100, Math.round((model.bytes_downloaded / model.expected_size_bytes) * 100));
  }
  return undefined;
}

function modelCoverageLabel(model: LocalModel): string {
  const supportsEnglish = model.supported_languages.includes('en');
  const supportsBangla = model.supported_languages.includes('bn');
  if (supportsEnglish && supportsBangla) return 'Bangla + English model';
  if (supportsBangla) return 'Bangla model';
  return 'English model';
}

function modelInstallStatus(
  model: LocalModel,
  progress: AnalysisProgress | undefined,
  percentage: number | undefined,
): string {
  if (progress?.event === 'failed') return progress.data.message;
  if (model.state === 'failed') return model.last_error ?? 'The download did not complete.';
  if (progress?.event === 'completed') return `${model.display_name} is verified and ready.`;
  if (progress?.event === 'queued')
    return `${model.display_name} is waiting for the download worker.`;
  if (progress?.event === 'downloading' || model.state === 'downloading') {
    return `${model.display_name} is downloading${percentage === undefined ? '' : ` · ${percentage}%`}.`;
  }
  return `${model.display_name} is downloaded once, verified, and kept on this device.`;
}

function transcriptReadinessLabel(
  status: string | undefined,
  segmentCount: number,
  language: string | null,
  pending: boolean,
  error: boolean,
): string {
  if (pending) return 'Checking…';
  if (error) return 'Unavailable';
  switch (status) {
    case 'completed':
      return [
        language ? transcriptionLanguageDisplay(language) : undefined,
        segmentCount > 0 ? `${segmentCount} cited segments` : 'Ready',
      ]
        .filter(Boolean)
        .join(' · ');
    case 'queued':
      return 'Queued locally';
    case 'processing':
      return 'Transcribing…';
    case 'attention':
      return 'Waiting to retry';
    case 'failed':
      return 'Needs another attempt';
    default:
      return 'Not prepared';
  }
}

function transcriptionActionLabel(
  progress: AnalysisProgress | undefined,
  transcriptStatus: string | undefined,
  pending: boolean,
): string {
  if (pending || progress?.event === 'queued') return 'Queuing transcript…';
  if (progress?.event === 'extracting') return 'Extracting audio…';
  if (progress?.event === 'transcribing') return 'Transcribing…';
  if (progress?.event === 'indexing') return 'Indexing transcript…';
  if (progress?.event === 'completed') return 'Finishing transcript…';
  if (transcriptStatus === 'queued') return 'Transcript queued';
  if (transcriptStatus === 'processing') return 'Transcribing…';
  if (transcriptStatus === 'attention') return 'Waiting to retry…';
  if (progress?.event === 'failed' || transcriptStatus === 'failed') return 'Retry transcription';
  return 'Transcribe this lecture';
}

function transcriptionLanguageLabel(language: TranscriptionLanguage): string {
  return language === 'bn' ? 'Bangla' : 'English';
}

function transcriptionLanguageDisplay(language: string): string {
  if (language === 'bn') return 'বাংলা (Bangla)';
  if (language === 'en') return 'English';
  return language.toUpperCase();
}

function analysisCapabilityHelp(reason: string | null): string {
  switch (reason) {
    case 'whisper_missing':
    case 'whisper_not_configured':
      return 'Install the Whisper transcription component. During development, configure LECTORBIT_WHISPER_PATH and restart LectorBit.';
    case 'ffmpeg_missing':
    case 'ffmpeg_not_configured':
      return 'Install or configure FFmpeg, then restart LectorBit.';
    case 'version_mismatch':
    case 'unsupported_version':
      return 'Install the supported Whisper engine version shown in Settings, then restart LectorBit.';
    default:
      return 'Open Settings for engine details, repair the local transcription components, then check again.';
  }
}

function assertLearningReady(transcriptStatus?: string, cloudConfigured?: boolean) {
  if (transcriptStatus !== 'completed') {
    throw new Error('Finish the local transcript before using grounded study tools.');
  }
  if (!cloudConfigured) {
    throw new Error('Add an OpenRouter API key in Settings before using grounded study tools.');
  }
}

function messageFrom(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Playback could not continue.';
}

function analysisErrorKind(cause: unknown): string | undefined {
  if (typeof cause !== 'object' || cause === null || !('kind' in cause)) return undefined;
  return typeof cause.kind === 'string' ? cause.kind : undefined;
}

function mediaErrorMessage(error: MediaError | null): string {
  switch (error?.code) {
    case 1:
      return 'Playback was interrupted. Retry the local stream.';
    case 2:
      return 'The private local video stream could not be read. Retry the stream.';
    case 3:
      return 'The system media engine could not decode this prepared video stream.';
    case 4:
      return 'The prepared video stream was rejected by the system media engine.';
    default:
      return 'This video could not start in the in-app player. Retry the local stream.';
  }
}

function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A', 'VIDEO'].includes(target.tagName)
  );
}

function sessionGoalKey(itemId: string): string {
  return `lectorbit.session-goal.${itemId}`;
}

function loadSessionGoal(itemId: string): string {
  if (!itemId) return '';
  try {
    return window.localStorage.getItem(sessionGoalKey(itemId)) ?? '';
  } catch {
    return '';
  }
}

function saveSessionGoal(itemId: string, value: string) {
  if (!itemId) return;
  try {
    if (value.trim()) window.localStorage.setItem(sessionGoalKey(itemId), value);
    else window.localStorage.removeItem(sessionGoalKey(itemId));
  } catch {
    // Private storage may be unavailable in a hardened WebView; the in-memory goal still works.
  }
}

function currentPlaybackPosition(view: PlaybackView, video: HTMLVideoElement | null): number {
  const livePosition =
    video &&
    video.readyState >= HTMLMediaElement.HAVE_METADATA &&
    Number.isFinite(video.currentTime)
      ? Math.round(video.currentTime * 1_000)
      : view.position_ms;
  return Math.max(view.raw_start_ms, Math.min(view.raw_end_ms, livePosition));
}

function learningMarkerLabel(kind: LearningMarkerKind): string {
  return kind === 'question' ? 'Question' : 'Takeaway';
}

function plainStudyText(value: string): string {
  return value
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/([*_])(.*?)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1');
}

function localIsoDate(): string {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 10);
}

const MAX_LEARNING_MARKER_LENGTH = 240;
const MIN_REPLAY_LOOP_MS = 5_000;
const REPLAY_LOOP_DURATIONS_MS = [15_000, 30_000, 60_000] as const;

const backLinkClass =
  'inline-flex h-10 items-center justify-center gap-2 rounded-lg border bg-background px-4 text-sm font-semibold transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';

const settingsLinkClass =
  'inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-input bg-background px-3 text-sm font-semibold transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';
