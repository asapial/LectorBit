# AI learning features

LectorBit uses AI to interpret lecture evidence and generate study content. It keeps scheduling, validation, progress, and plan feasibility deterministic.

## Implemented workflow

1. Whisper creates a versioned transcript with timestamped segments.
2. The user explicitly enables cloud processing and starts lecture analysis.
3. A persistent background job sends the transcript to the configured OpenRouter free model.
4. Rust validates every returned segment ID, replaces model timestamps with canonical transcript timestamps, and stores a versioned `lecture_understanding` artifact.
5. Chapters, concepts, objectives, prerequisites, formulas, examples, and difficulty evidence can seek the player to their supporting moment.
6. Study materials are generated from the same evidence and normalized into individual review items.
7. Review attempts are stored with confidence, response time, quality, and review state. A deterministic SM-2-style function calculates every due date.
8. The Study Hub provides a global due queue with search, difficulty and archive filters, editable prompts/answers/hints, evidence jumps, and archive/restore controls.

Analysis is user-triggered instead of silently starting after Whisper because transcript upload requires explicit consent. The persistent job and recovery path are ready for automatic enqueueing if a durable cloud-consent preference is added later.

## Player companion

The player supports grounded actions for the current playback position:

- Explain this section
- Summarize the last five minutes
- Give me an example
- Quiz me on this chapter
- Define the terms used here

Only a narrow transcript window is sent. Returned segment references are checked before display, and evidence buttons seek the player to the canonical timestamp.

The **Explain this frame and save note** action captures the currently displayed video frame at reduced resolution, combines it with nearby transcript evidence, generates a detailed explanation, and stores it as a timestamped note. The consent label explicitly describes both transcript and frame disclosure.

## Transcript correction and artifact health

The Player contains a synchronized, searchable transcript panel. When whisper.cpp emits token probabilities, the panel shows their segment average and flags low-confidence evidence; missing scores remain unknown. Selecting a timestamp seeks the player, and correcting a segment creates a new immutable transcript version rather than overwriting the original evidence. The previous transcript is superseded and downstream lecture-understanding artifacts are marked stale in AI Studio so an older analysis is never presented as current by accident.

AI Studio also exposes:

- artifact health and the transcript version behind each artifact;
- a redacted cloud-request ledger with provider, model, disclosure scope, latency, token usage, and failure state;
- a clipboard export of that ledger whose schema explicitly excludes prompts and transcript content;
- a unified view of model download, transcription, lecture-understanding, scan, and probe jobs;
- safe controls to cancel work that has not started and retry failed or cancelled work with its original durable payload;
- explicit local/cloud execution boundaries for each capability.

The global command palette (`Ctrl+K` or `Cmd+K`) opens AI Studio, Study Hub, Search, and the other main workspaces without requiring route knowledge.

Plan commits and automatic replans remain immutable. The Plan Builder lists recent versions with workload totals and deterministic counts of blocks added, removed, or moved relative to the preceding version.

## Planning boundary

Normal plan generation remains algorithmic. AI is optional for only:

- converting natural-language constraints into a typed proposal that Rust must validate before changes are committed;
- suggesting prerequisite relationships from stored, transcript-grounded lecture summaries.

The model cannot choose dates, feasibility, scheduling priority, or review intervals.

## OCR roadmap

The current-frame explanation provides immediate visual understanding without scanning an entire course. The database also reserves the versioned `ocr_text` artifact kind for a later bulk pipeline:

1. detect scene changes deterministically;
2. select representative frames;
3. run a dedicated OCR model only on selected frames;
4. deduplicate repeated slide text;
5. merge OCR spans with transcript timestamps;
6. generate combined-evidence learning artifacts.

Bulk OCR is intentionally not advertised as complete until an OCR model is added to the catalog and evaluated on formulas, code, diagrams, and multilingual slides.
