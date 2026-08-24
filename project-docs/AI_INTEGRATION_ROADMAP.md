# LectorBit whole-product AI integration roadmap

Audit date: 2026-08-24

## Product direction

LectorBit should become an **evidence-first learning system**, not a generic chat wrapper. Its unique loop is:

1. import authorized lecture media;
2. extract timestamped evidence locally;
3. turn evidence into concepts, chapters, examples, and practice;
4. measure what the learner actually watched and remembered;
5. let a deterministic planner schedule the next best action;
6. show the learner why an answer or recommendation exists and jump to its source.

AI may interpret, summarize, retrieve, and generate. It must not silently own dates, feasibility, progress, consent, or review intervals.

## Current implementation audit

| Capability                            | Current state              | What is solid                                                                                                                        | What remains                                                                                                                                  |
| ------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Local model catalog                   | Implemented                | Pinned manifest, download resume, disk check, SHA-256 verification, quarantine/remove flow                                           | Add capability metadata, more models, hardware compatibility, and model health checks                                                         |
| Local Whisper transcription           | Implemented                | Authorized media lookup, sidecar validation, persistent jobs, restart recovery, versioned transcript segments, synchronized transcript viewer, token-derived confidence when emitted, and correction-by-supersession | Add cooperative running-job cancellation and performance presets                                                                              |
| Keyword transcript search             | Implemented                | SQLite FTS5 over media names, transcripts, and annotations; timestamp results; source filters; shareable query URLs                    | Add result grouping, hybrid semantic retrieval, and query suggestions                                                                         |
| OpenRouter key storage                | Implemented                | OS credential store; key is not returned to the renderer or stored in SQLite                                                         | Rename provider layer so it is not planning-specific; add provider/model policy and connection test                                           |
| Natural-language planning constraints | Implemented                | Model output is normalized into typed fields and Rust validates it; immutable plan history shows added, removed, and moved blocks between versions | Add clearer rejected-field feedback and evaluation fixtures                                                                                    |
| AI prerequisite/order suggestion      | Implemented                | Limited candidate envelope, redacted paths, optional grounded summaries, deterministic feasibility boundary, redacted request provenance | Consolidate provider fallback logic                                                                                                            |
| Lecture understanding                 | Implemented                | Persistent background job, input hash, versioned artifact, prompt/schema version, canonical timestamp hydration, citation validation, stale-artifact detection, transcript correction loop, and failed-job retry | Add cooperative running-job cancellation and partial progress                                                                                  |
| Player companion                      | Implemented                | Narrow time-local transcript evidence and canonical seek buttons                                                                     | Add conversational history with strict evidence scope, follow-up questions, and answer quality feedback                                       |
| Current-frame explanation             | Implemented                | Reduced captured frame, nearby transcript, stored note, frame hash                                                                   | Add user-controlled crop, diagram/formula mode, evidence display on saved notes, and OCR reuse                                                |
| Study material generation             | Implemented                | Four item types, transcript citations, normalized storage, global editing, archive/restore, and user-edited provenance                | Add deduplication scoring and generation-time difficulty controls                                                                              |
| Review scheduling                     | Implemented, deterministic | Append-only attempts, SM-2-style local due-date calculation, dedicated Study Hub queue, recall summaries, and plan workload warning   | Add concept-level mastery, lapse targeting, and automatic plan block proposals                                                                 |
| Consent model                         | Partially wired            | Per-request booleans and a consent-event schema/service exist                                                                        | Active cloud paths do not append a structured consent ledger; scopes, payload summaries, revoke policy, and UI history must be connected      |
| AI jobs and recovery                  | Partially unified          | Transcription and lecture understanding recover after restart; AI Studio and the global shell show a deduplicated cross-system activity feed; queued work can be cancelled and failed/cancelled work safely retried | Add cooperative running-job cancellation, priority, backoff, and concurrency controls                                                         |
| Provider gateway                      | Partially implemented      | Timeouts, no redirects, JSON mode, response cleaning, free-model fallbacks                                                           | Planning and learning duplicate clients/key access/error mapping; create one gateway and one policy layer                                     |
| OCR                                   | Scaffold only              | `ocr_text` artifact kind and diagnostics capability flag exist                                                                       | No model catalog entry, scene detection, worker, repository API, IPC, evaluation set, or UI                                                   |
| Embeddings / semantic search          | Scaffold only              | Diagnostics capability flag exists                                                                                                   | No embedding model, chunk schema, index, retrieval service, reranker, IPC, or UI                                                              |
| Local LLM                             | Not implemented            | Architecture already keeps model code backend-only                                                                                   | Select supported runtime/model, resource budgets, fallback behavior, and quality/security evaluation                                          |
| AI evaluation and observability       | Early                      | Strong DTO validation, prompt-injection framing, deterministic tests, and an exportable redacted request ledger with latency, token usage, scope, provider, and failure state | Add golden datasets, citation precision, unsupported-claim rate, budgets, and regression gates                                                |
| AI discovery UX                       | Implemented foundation     | AI Studio centralizes readiness, workflows, artifact health, request provenance, safe job controls, trust boundaries, and capability routing; global command access is available | Add model recommendations and first-run onboarding                                                                                             |

## Target architecture

```text
Authorized media
  -> deterministic scene/audio extraction
  -> versioned evidence store (transcript + OCR + frame references)
  -> local FTS + local embedding index
  -> retrieval service with media/time/security filters
  -> AI gateway (local or cloud policy, structured output, budgets, provenance)
  -> versioned learning artifacts
  -> learner actions and review outcomes
  -> deterministic mastery inputs and planner
  -> Today queue with “why this next?” explanations
```

### Required shared services

1. **Evidence service**: one API for transcript segments, OCR spans, frames, annotations, and canonical timestamps.
2. **AI gateway**: one backend-only client interface for OpenRouter and future local inference. It owns timeouts, retry/backoff, structured output, provider selection, request size, redaction, and safe errors.
3. **Prompt registry**: prompt ID, version, input schema, output schema, model capability, maximum context, and evaluation suite.
4. **Retrieval service**: hybrid FTS/vector search with explicit library-root, media, chapter, and time filters. Every returned passage carries immutable evidence IDs.
5. **Consent and disclosure service**: append-only event for every cloud request, including scope, provider, data categories, approximate size, result, and revocation policy—never raw user content or secrets.
6. **Unified AI jobs**: typed jobs with priority, progress, cancel, retry, restart recovery, attempt limit, and resource class (`cpu`, `gpu`, `network`).
7. **AI provenance**: artifact records include provider, exact resolved model, prompt version, schema version, input hash, evidence IDs, generation time, and supersession state.

## Delivery plan

### Phase 0 — Stabilize the current vertical slice (1–2 weeks)

- Extract duplicated OpenRouter code into an `AiGateway` trait and one concrete provider adapter.
- Replace hard-coded model strings with a provider capability policy: text JSON, vision JSON, context size, health, and fallback order.
- Connect active planning and learning requests to the append-only consent ledger.
- Define cloud disclosure scopes: `planning_metadata`, `lecture_transcript`, `companion_window`, and `frame_plus_transcript`.
- Unify AI job status/error DTOs and add cancellation/retry contracts.
- Add exact resolved model and request duration to safe provenance. Record token usage when returned, without prompts or user text.
- Build golden fixtures for planning intent, prerequisites, lecture chapters, companion answers, frame notes, and study items.
- Gate releases on schema validity, citation validity, and no-secret/no-path leakage tests.

Exit criteria: every AI call uses the gateway, records consent/provenance, has a bounded input/output, and has a regression fixture.

### Phase 1 — Complete the shipped experience (2–3 weeks)

- Add first-run AI onboarding: local-only, hybrid, or cloud-assisted; all choices remain reversible.
- Expand AI Studio with artifact counts, current jobs, retry/cancel controls, and capability-specific setup actions.
- Add transcript viewer/editor with timestamps, confidence, search, and “regenerate downstream artifacts” warning.
- Add stale badges when a transcript, prompt, or model changed after an artifact was created.
- Move due study items into a dedicated Today review queue; do not make learners open a video to find due cards.
- Let users edit, archive, regenerate, and rate AI-generated study items.
- Add inline “why unavailable?” explanations to disabled AI actions.
- Preserve per-request consent, with an optional durable preference scoped by data category rather than one global cloud toggle.

Exit criteria: a new user can discover, configure, run, monitor, correct, and review every currently implemented AI feature without guessing where it lives.

### Phase 2 — Multimodal evidence: selective OCR (3–4 weeks)

- Add deterministic scene-change detection using FFmpeg and select representative frames.
- Evaluate an OCR model on slides, code, formulas, diagrams, low contrast, and multilingual text before adding it to the verified catalog.
- Create versioned OCR spans with frame timestamp, bounding boxes, confidence, model version, and frame hash.
- Deduplicate repeated slide text and merge OCR spans with transcript time windows.
- Make OCR searchable and visible as a transcript-adjacent evidence track.
- Reuse stored OCR for frame explanations instead of re-reading the same frame repeatedly.
- Add explicit storage controls for retained thumbnails and derived text.

Exit criteria: OCR improves retrieval on a fixed benchmark, never scans every frame by default, and every extracted claim jumps to a visible source moment.

### Phase 3 — Local hybrid semantic search and library Q&A (3–4 weeks)

- Add a small verified local embedding model with hardware and disk requirements in the catalog.
- Define immutable embedding chunks from transcript/OCR evidence; never embed absolute paths, secrets, or unrelated metadata.
- Start with an auditable local index. Benchmark SQLite-based exact search before adopting an ANN extension.
- Combine FTS, vector similarity, recency/course filters, and deterministic score normalization.
- Add a retrieval inspector showing the exact passages selected for an answer.
- Build “Ask my library” with strict root/media scope, source timestamps, insufficient-evidence behavior, and no-answer evaluation.
- Cache embeddings and retrieval by content hash; rebuild only changed evidence.

Exit criteria: hybrid search beats FTS on the evaluation set, stays responsive on the target library size, and all answers expose source moments.

### Phase 4 — Adaptive mastery coach (3–4 weeks)

- Derive deterministic mastery signals from review quality, confidence, response time, lapses, coverage, and recency.
- Use AI only to generate targeted explanations and practice variants for weak concepts.
- Build a concept graph from evidence-linked concepts and prerequisites, with user corrections taking precedence.
- Add “confusion memory”: user-marked confusing moments and failed questions become retrieval inputs for later practice.
- Feed mastery and due-review workload into the deterministic planner as typed constraints/weights—not model-selected dates.
- Add “why this next?” using planner facts and evidence, not free-form hidden reasoning.
- Support comparison across lectures: “Where else was this concept taught?” and “What prerequisite am I missing?”

Exit criteria: targeted practice improves measured recall on a pilot set without allowing model output to bypass planning invariants.

### Phase 5 — Private local generation and provider choice (3–5 weeks)

- Benchmark a small local instruct model for structured study tasks on supported hardware tiers.
- Add explicit CPU/RAM/VRAM budgets, pause-on-battery/thermal policies, and one-job-at-a-time defaults.
- Route each task through a capability matrix: deterministic implementation, local model, cloud model, or unavailable.
- Let the user choose local-only, prefer-local, or configured cloud per data category.
- Keep prompt schemas and artifact formats provider-independent so local and cloud outputs are interchangeable and versioned.

Exit criteria: supported devices can complete a documented subset fully offline, and unsupported devices fail clearly without degrading deterministic study features.

## UI and UX system plan

- Keep AI Studio as the single readiness and workflow hub; keep contextual actions inside Library, Player, Plan, Search, and Today.
- Use consistent states everywhere: `not configured`, `ready`, `queued`, `running`, `needs attention`, `completed`, `stale`, `failed`, `cancelled`.
- Never use a disabled button as the only explanation. Pair it with the missing prerequisite and a direct fix action.
- Show a disclosure summary before a cloud request: provider, data categories, approximate scope, and retention caveat.
- Show evidence and model provenance after a request, with one-click seek to canonical timestamps.
- Prefer progressive disclosure: primary study action first; advanced model/provider controls stay in Settings.
- Add keyboard navigation, focus restoration after dialogs/jobs, `aria-live` progress announcements, reduced-motion support, and minimum 44px touch targets.
- Use the canonical LectorBit mark in the desktop bundle, favicon, sidebar, compact topbar, installer, and release assets. Do not substitute letters or unrelated framework marks.
- Keep copy precise: media files remain local; opted-in transcript text, planning metadata, or a reduced frame may be sent to the configured provider.

## Evaluation and release gates

### Quality metrics

- Citation validity: 100% of cited IDs exist and map to canonical timestamps.
- Citation support precision: target at least 95% on a manually labelled lecture set.
- Unsupported-claim rate: target below 2% for summaries and below 1% for direct factual answers.
- Chapter boundary quality, study-item duplication, answer correctness, and OCR character/formula accuracy each have task-specific golden sets.
- Retrieval: Recall@10, MRR, no-answer precision, and latency at small/medium/large library sizes.
- Learning: review completion, lapse rate, time-to-correct-answer, and retained recall—not number of AI calls.

### Security and privacy gates

- Prompt-injection fixtures in transcript and OCR text.
- Secret, API-key, absolute-path, and personal-data leak tests.
- Request-size, image-size, timeout, redirect, content-type, and response-schema enforcement.
- Consent event present for every cloud request and absent for fully local operations.
- Model and sidecar signature/hash verification; safe archive extraction; restricted process arguments.
- No raw prompt, transcript, frame, provider body, or credential in normal logs/telemetry.

### Reliability gates

- Restart every job type mid-flight and verify recovery/idempotency.
- Cancel every job type and verify no partial artifact becomes active.
- Supersede transcript/model/prompt versions and verify stale artifacts remain inspectable but are not mistaken for current.
- Simulate offline, rate limit, provider timeout, malformed JSON, unknown citations, low disk, missing sidecar, and corrupted model.

## Recommended first 30 days

1. Land the AI gateway and provider capability policy.
2. Wire structured consent and safe provenance to all cloud requests.
3. Add unified cancel/retry job contracts and AI Studio controls.
4. Create the evaluation harness and a small representative lecture corpus before adding new models.
5. Ship transcript correction plus stale-artifact handling.
6. Put due reviews on Today and add study-item feedback/editing.
7. Prototype selective OCR only after the current vertical slice meets its release gates.

## Effort and sequencing

For one experienced Rust engineer and one frontend/product engineer working together, Phases 0–4 are roughly **12–17 calendar weeks**, assuming the evaluation corpus and representative media are available. Phase 5 is another **3–5 weeks** and should remain optional because hardware support and model licensing can dominate the schedule. A single developer should plan closer to **20–28 weeks** for the same scope.

Do not run OCR, embeddings, and a local LLM as three parallel model experiments before Phase 0 is complete. The gateway, evidence identifiers, consent scopes, provenance, jobs, and evaluations are shared foundations; implementing them once prevents every later feature from creating a new privacy and reliability path.
