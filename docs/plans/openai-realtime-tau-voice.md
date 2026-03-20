# OpenAI Realtime Tau-Style Voice Eval Plan

## Goal

Build a local, eval-focused voice simulation harness in promptfoo that is inspired by Tau-Bench, targets OpenAI realtime audio models, stores useful artifacts for debugging and grading, and works entirely inside this repository.

## Success Criteria

- Local simulated-user turns run in-process without Promptfoo's remote generation service.
- OpenAI realtime provider accepts audio input envelopes and returns normalized audio, transcript, tool-call, and timing artifacts.
- A Tau-style voice eval provider can run multi-turn voice interactions against a target provider.
- Eval outputs can be graded with existing assertions, especially `llm-rubric`, trajectory assertions, and trace assertions.
- Examples, tests, and docs cover the main workflow.
- End-to-end QA runs against real OpenAI APIs using a local `.env` file outside this repository.

## Scope

### Phase 1: Foundation

- [x] Refactor simulated-user provider plumbing so local providers can generate user turns.
- [x] Align the OpenAI realtime provider with current audio input/output handling.
- [x] Define a reusable voice trajectory metadata shape for multi-turn evals.

### Phase 2: Harness

- [x] Add a Tau-style voice eval provider that orchestrates simulated user text, TTS, realtime target calls, transcripts, and stop conditions.
- [x] Persist normalized artifacts in `metadata.messages` and `metadata.voiceTurns`.
- [x] Emit trace spans and useful metadata for assertions and debugging.

### Phase 3: Grading

- [x] Ensure the final provider response works with `llm-rubric`.
- [x] Ensure trajectory and trace assertions can evaluate the voice run.
- [x] Add helper metadata that makes transcript- and trace-aware grading straightforward.

### Phase 4: Validation

- [x] Add unit tests for local simulation and realtime artifact normalization.
- [x] Add example configs for OpenAI realtime voice evals.
- [x] Run lint, format, targeted tests, and at least one end-to-end eval using a local API key source.

## Implementation Notes

- Start with half-duplex turn-taking rather than full-duplex orchestration.
- Reuse promptfoo tracing, eval UI, and assertion infrastructure instead of building parallel systems.
- Preserve backward compatibility where practical, especially around existing simulated-user configs.
- Keep raw audio/transcript payloads out of git history and plan updates.

## Progress Log

### 2026-03-19

- Created feature branch `feature/openai-realtime-tau-voice`.
- Completed repo, Promptfoo, pc, Tau-Bench, and OpenAI docs scan.
- Identified main gaps: simulated-user is remote-bound, realtime provider needs protocol alignment, and the voice eval harness needs a local Tau-style orchestrator.
- Added shared Tau simulator prompt helpers in `src/providers/tauShared.ts`.
- Updated `promptfoo:simulated-user` to support a nested local `userProvider` while preserving the remote hosted default.
- Added registry support for resolving nested providers in simulated-user configs.
- Added and passed targeted tests for local simulated-user execution.
- Updated `src/providers/openai/realtime.ts` to accept `audio_input` envelopes, normalize current realtime output audio/transcript events, support persistent conversation IDs, and capture richer metadata for transcripts, audio, tools, and event counts.
- Added and passed targeted realtime provider tests for audio input envelopes, output alias normalization, persistent function callbacks, and existing connection behavior.
- Added `openai:speech:*` as a local TTS provider backed by OpenAI's `/audio/speech` endpoint, with promptfoo audio normalization and tracing.
- Added `promptfoo:tau-voice`, a local Tau-style voice harness that runs simulated user generation, TTS, realtime target calls, and transcript assembly inside promptfoo.
- Removed per-run mutation of shared realtime provider instructions by passing target instructions through per-call prompt context instead.
- Extended realtime voice metadata to carry session IDs, input/output transcripts, tool-call details, event counts, and voice-turn latency breakdowns.
- Added and passed targeted tests for the new OpenAI speech provider and Tau voice harness.
- Added audio-buffer clearing and current tool-shape normalization in the realtime provider so synthesized half-duplex turns work reliably with OpenAI's current realtime API.
- Added `initialMessages` support to `promptfoo:tau-voice` so voice evals can seed conversation state before the first simulated user turn.
- Tightened the shared Tau simulator prompt to reduce role drift and assistant-message echoing in local simulated-user loops.
- Added site docs for Tau Voice, updated the OpenAI and simulated-user provider docs, and documented voice-specific assertion guidance around ASR-sensitive identifiers.
- Added a complete `examples/openai-realtime-tau-voice/` example with local simulator, OpenAI TTS, OpenAI realtime target, trajectory assertions, and tracing.
- Ran focused Vitest coverage for realtime, speech, tau voice, simulated user, and shared Tau prompt helpers.
- Ran `npm run tsc -- --pretty false` successfully after the provider and example changes.
- Ran Biome checks on the touched provider, test, docs, and example files.
- Ran `SKIP_OG_GENERATION=true npm run build` in `site/` successfully after the provider doc updates.
- Ran a live end-to-end eval with `npm run local -- eval -c examples/openai-realtime-tau-voice/promptfooconfig.yaml --env-file ~/code/promptfoo/.env --no-cache --max-concurrency 1 -o /tmp/openai-realtime-tau-voice.json`, and the example passed against real OpenAI APIs.
- Hardened the Tau Voice artifact model with per-turn and conversation-level retranscription, diarized conversation transcripts, and explicit `costBreakdown` metadata.
- Added shared WAV helpers and propagated sample rate, channel count, duration, usage breakdowns, and estimated TTS cost metadata through the OpenAI speech and realtime providers.
- Updated OpenAI transcription cost handling to use returned token usage for `gpt-4o-*transcribe`, while keeping `whisper-1` on legacy per-minute fallback pricing.
- Tightened the airline example with ASR-tolerant profile resolution, morning-flight fixture data, a JavaScript assertion over tool outputs, and a tool-only `trajectory:step-count` check.
- Fixed diarization requests by sending `chunking_strategy: auto` for diarized transcription runs.
- Improved assistant-turn transcript verification from strict string equality to similarity-based matching so voice-normalized numbers and timestamps do not produce false negatives.
- Re-ran focused Vitest coverage for realtime, speech, transcription, tau voice, simulated user, and shared Tau prompt helpers after the hardening changes.
- Re-ran `npm run tsc -- --pretty false`, Biome checks, and the docs site build successfully after the hardening changes.
- Re-ran the live end-to-end eval with `npm run local -- eval -c examples/openai-realtime-tau-voice/promptfooconfig.yaml --env-file ~/code/promptfoo/.env --no-cache --max-concurrency 1 -o /tmp/openai-realtime-tau-voice-qa.json`, confirmed the hardened example passed, and inspected the saved WAV plus retranscription artifacts.
- Verified the missing-key failure path still exits fast with `Missing OPENAI_API_KEY (openai:realtime:gpt-realtime)`.

### 2026-03-20

- Consolidated Tau initial-message parsing, templating, and validation in `src/providers/tauShared.ts` so `promptfoo:simulated-user` and `promptfoo:tau-voice` share one seeded-history path.
- Added a registry guard that rejects nested orchestration providers such as `promptfoo:simulated-user` or `promptfoo:tau-voice` inside nested provider slots, preventing recursive or semantically invalid configs.
- Simplified `src/providers/openai/realtime.ts` by removing dead persistent-connection state and centralizing final realtime response assembly and fallback-text extraction.
- Fixed direct realtime finalization to omit audio metadata when usage reports audio tokens but no audio bytes were received, instead of emitting a null-data audio payload.
- Added Tau Voice negative coverage for malformed and invalid `initialMessages`, plus a realtime regression test for the missing-audio-bytes case.
- Re-ran focused Vitest coverage, typecheck, Biome, and a live end-to-end voice eval after the audit pass.
- Synced OpenAI model allowlists and pricing coverage with current docs/SDK aliases for realtime, audio, TTS, and mini-transcribe snapshots, and preserved audio `duration` through the unified audio wrapper so Tau Voice metadata keeps that artifact.

### Local-First Regular Simulated User

- [x] Keep the regular simulated-user control flow and output shape unchanged by injecting the default user model in the registry, not by rewriting the orchestration loop.
- [x] Leave `promptfoo:redteam:mischievous-user` untouched; its inherited hosted fallback remains out of scope for this cutover.
- [x] Default plain `promptfoo:simulated-user` to a local OpenAI chat provider when `userProvider` is omitted.
- [x] Source the default model id from `src/providers/openai/defaults.ts` so the registry does not duplicate OpenAI model choices.
- [x] Update docs to explain that normal simulated-user is local-first now, with `userProvider` still available for explicit model control.
- [x] Verify with focused unit tests and a live eval that plain `promptfoo:simulated-user` no longer depends on Promptfoo's hosted simulator in the normal registry-loaded path.

#### Validation Notes

- Focused Vitest: `test/providers/registry.test.ts` and `test/providers/simulatedUser.test.ts` passed.
- Typecheck: `npm run tsc -- --pretty false` passed.
- Docs build: `cd site && SKIP_OG_GENERATION=true npm run build` passed.
- Live eval with `PROMPTFOO_DISABLE_REMOTE_GENERATION=true` and plain `promptfoo:simulated-user` passed on the first integration-tau test, proving the normal registry-loaded path stayed local.
- A no-key smoke with an `echo` target failed in `SimulatedUser.sendMessageToLocalUser` with the local OpenAI API key error, which confirms the omitted-`userProvider` path no longer falls back to the hosted simulator.
- Removed hidden `_resolved*` config transport from regular `SimulatedUser` and `TauVoiceProvider` in favor of explicit constructor wiring for resolved nested providers.
- Narrowed nested provider config types back to serializable references (`string | ProviderOptions`) and kept live `ApiProvider` instances as internal constructor-only inputs.
- Re-ran focused registry, simulated-user, and tau-voice Vitest coverage, plus live local smokes for plain simulated-user and Tau Voice after the interface cleanup.
