# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`expo-edge-speech` is a TypeScript library that provides an `expo-speech`-compatible API backed by Microsoft's Edge TTS WebSocket service. Library source lives in `src/` and compiles to `dist/`. The repo is a Yarn 4 workspace with `example-app/` (an Expo demo) and a separate Docusaurus site in `website/` (sourced from `docs/`).

## Commands

Package manager is **yarn 4.9.1** (see `packageManager`). Use `yarn` rather than `npm` at the repo root.

- `yarn build` — `tsc` to `dist/` (run before publishing; `prepublish` already calls it).
- `yarn dev` — `tsc --watch` for incremental library builds while developing the example app.
- `yarn test` — full Jest suite (`jest-expo` preset, node env, tests in `__tests__/*.test.ts`).
- `yarn test:watch` / `yarn test:coverage` — watch mode / coverage report.
- Single test: `yarn jest __tests__/networkService.test.ts` (or `-t "<name pattern>"` to filter cases).
- `yarn lint` — `expo lint` (ESLint with `expo` + `prettier` configs; `dist/` and `example-app/` are ignored).
- Example app: `cd example-app && npx expo start` (or `--ios` / `--android`). The app depends on the library via `workspace:*`, so run `yarn dev` in the root in parallel to pick up changes.
- Docs site: `cd website && npm ci && npm run build` (Docusaurus; deployed by `.github/workflows/deploy-docs.yml` on pushes to `master` that touch `docs/**` or `website/**`).

## Architecture

The library follows a strict 3-layer design described in detail in `docs/DEVELOPMENT-workflow.md`. Key rule: the public API in `src/Speech.ts` is the only entry point external code should use; everything else is internal and must not be exported from `src/index.ts` unless intentionally part of the public surface.

### Layers

- **API layer** — `src/Speech.ts`: `SpeechAPI` singleton exposing `speak`, `stop`, `pause`, `resume`, `isSpeakingAsync`, `getAvailableVoicesAsync`, `cleanup`, `configure`, `maxSpeechInputLength`. `configure()` *must* be called before the first `speak()` — afterward `configurationLocked` is set and further `configure()` calls throw. Services are constructed lazily on first use in dependency order: `StorageService → AudioService → NetworkService → VoiceService → StateManager → ConnectionManager → Synthesizer`.
- **Core layer** — `src/core/`:
  - `synthesizer.ts` — orchestrates a single `speak()` call: resolves voice via `VoiceService`, builds SSML via `utils/ssmlUtils.ts`, hands work to `ConnectionManager`.
  - `connectionManager.ts` — owns connection pooling, the **circuit breaker** (`Closed`/`Open`/`HalfOpen`), retry/backoff, app-state subscription, and the audio handoff to `AudioService`.
  - `state.ts` — `StateManager` and `ApplicationState` enum. Single source of truth for `SynthesisSession` (id + connectionId), state transitions, and cross-service coordination.
- **Services layer** — `src/services/`:
  - `networkService.ts` — Edge TTS WebSocket protocol (auth via `Sec-MS-GEC` token, binary message parsing, boundary events). **Batch processing**: collects all audio chunks before resolving the synthesis promise.
  - `audioService.ts` — `expo-audio` playback (`createAudioPlayer` + listener-based status), unified `setAudioModeAsync`, `AudioPlaybackState` / `UserActionState` enums.
  - `storageService.ts` — connection-scoped audio buffers with memory limits and cleanup; per-connection isolation.
  - `voiceService.ts` — voice list fetch + TTL cache, expo-speech-shaped `EdgeSpeechVoice` transform, language/gender/persona filtering.
- **Utils** — `src/utils/`: `ssmlUtils.ts` (SSML generation, parameter→percent conversion), `audioUtils.ts` (Edge TTS binary message + MP3 validation), `commonUtils.ts` (id generation, parameter validation per `PARAMETER_RANGES`).
- **Constants & types** — `src/constants.ts` (Edge TTS endpoints, parameter ranges, `MAX_TEXT_LENGTH = 1000`, default voice `en-US-EmmaMultilingualNeural`), `src/types.ts` (all public types and config shapes), `src/rn-types.ts` (RN-specific WebSocket typings).

### Critical design choice: batch processing

Synthesis is **fully batch**, not streaming: `NetworkService.synthesizeText()` collects every audio chunk and boundary into a single `SynthesisResponse` before returning, then `ConnectionManager` writes everything to `StorageService` and triggers `AudioService.speak()` against the merged buffer. Do not introduce intermediate playback or partial flushes — the rest of the pipeline (MP3 validation, temp-file creation, callback ordering) assumes a complete buffer. The full sequence is diagrammed at the bottom of `docs/DEVELOPMENT-workflow.md`.

### Sessions and connections

Every `speak()` call creates a `SynthesisSession` with both an `id` (session, for state tracking) and a `connectionId` (for storage buffer + WebSocket). `connectionId` is the key into `StorageService` buffers and `ConnectionManager` coordinators — when adding new cross-service code, prefer threading `connectionId` over re-deriving it.

## Testing notes

- Jest config: `jest.config.js` (preset `jest-expo`, setup `__tests__/setup.ts`, fixtures in `__tests__/__fixtures__/`, image/audio assets stubbed via `__mocks__/fileMock.js`).
- Tests are co-located by module name (`audioService.test.ts`, `connectionManager.test.ts`, etc.). When changing a service, run that file plus `partial-integration.test.ts` and `Speech.test.ts` for end-to-end coverage.
- `transformIgnorePatterns` already whitelists Expo/RN packages — if a new dep needs transformation, extend that pattern rather than disabling it.

## Config & types contract

Public configuration goes through `Speech.configure(config: SpeechAPIConfig)` and is split per-service (`network`, `connection`, `audio`, `storage`, `voice`). When adding a new tunable, define it in `src/types.ts`, plumb it through the corresponding service's constructor, and document defaults in `docs/configuration.md`. Keep `src/index.ts` exports in sync — only re-export types that are part of the public API.
