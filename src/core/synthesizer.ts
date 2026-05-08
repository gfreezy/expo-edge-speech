import * as FileSystem from "expo-file-system/legacy";

import type {
  SpeechOptions,
  EdgeSpeechVoice,
  WordBoundary,
  SpeechError,
} from "../types";
import {
  generateConnectionId,
  generateSessionId,
} from "../utils/commonUtils";
import { generateSSML } from "../utils/ssmlUtils";
import { StateManager, ApplicationState, SynthesisSession } from "./state";
import { ConnectionManager } from "./connectionManager";
import { AudioService, AudioPlaybackState } from "../services/audioService";
import { VoiceService } from "../services/voiceService";
import { NetworkService } from "../services/networkService";

/**
 * Result of a synthesize-only call (no audio playback).
 */
export interface SynthesisResult {
  /** Merged audio bytes in MP3 format. */
  audio: Uint8Array;
  /** Reported synthesis duration in milliseconds (0 when not provided). */
  durationMs: number;
}

/**
 * Result of writing a synthesis to disk.
 */
export interface SynthesisFileResult {
  /** File URI where audio was written. */
  uri: string;
  /** Audio duration in milliseconds (0 when not provided). */
  durationMs: number;
  /** Number of bytes written. */
  size: number;
}

/** Per-chunk callback used by `synthesize`. */
export type SynthesisChunkListener = (chunk: Uint8Array) => void;

/**
 * Main synthesizer that coordinates complete speech synthesis workflow.
 * Provides expo-speech compatible API while coordinating all internal services.
 */
export class Synthesizer {
  private stateManager: StateManager;
  private connectionManager: ConnectionManager;
  private audioService: AudioService;
  private voiceService: VoiceService;
  private networkService: NetworkService;

  private sessions: Map<string, SynthesisSession> = new Map();
  private currentSession: SynthesisSession | null = null;

  constructor(
    stateManager: StateManager,
    connectionManager: ConnectionManager,
    audioService: AudioService,
    voiceService: VoiceService,
    networkService: NetworkService,
  ) {
    this.stateManager = stateManager;
    this.connectionManager = connectionManager;
    this.audioService = audioService;
    this.voiceService = voiceService;
    this.networkService = networkService;

    this.setupEventHandlers();
  }

  /**
   * Setup event handlers for service coordination
   */
  private setupEventHandlers(): void {
    // Register for state change notifications from StateManager
    this.stateManager.addStateChangeListener((event) => {
      try {
        if (event.type === "application" && this.currentSession) {
          const previousState = this.currentSession.state;
          // Synchronize currentSession.state with StateManager application state
          this.currentSession.state = event.newState;
          console.log(
            `[Synthesizer] Session state synchronized: ${previousState} → ${event.newState}`,
          );

          // Validate state synchronization to catch inconsistencies
          if (event.newState !== this.currentSession.state) {
            console.warn(
              `[Synthesizer] State synchronization warning: expected ${event.newState}, got ${this.currentSession.state}`,
            );
          }
        }
      } catch (error) {
        console.error(
          "[Synthesizer] Error during state synchronization:",
          error,
        );
        // Continue execution to prevent critical failures
      }
    });
  }

  /**
   * Main speech synthesis function - expo-speech compatible
   */
  async speak(text: string, options: SpeechOptions = {}): Promise<void> {
    try {
      // Validate input
      if (!text || text.trim().length === 0) {
        throw new Error("Text cannot be empty");
      }

      // Create synthesis session using StateManager to get the authoritative session object
      const session = await this.stateManager.createSynthesisSession(
        text,
        options,
      );

      // Store this authoritative session locally in the Synthesizer's session map
      // Note: this.sessions is a Map<string, SynthesisSession> in Synthesizer
      this.sessions.set(session.id, session);

      // Update the session to synthesizing state in StateManager
      await this.stateManager.updateSynthesisSession(session.id, {
        state: ApplicationState.Synthesizing,
      });

      // Process the session using the authoritative session object from StateManager
      // This ensures that processSession receives the session with the correct connectionId
      await this.processSession(session);
    } catch (error) {
      const speechError: SpeechError = {
        name: "SynthesisError",
        code: "synthesis_error",
        message:
          error instanceof Error ? error.message : "Unknown synthesis error",
      };

      options.onError?.(speechError);

      // Use proper StateManager session management instead of setState
      if (this.currentSession) {
        await this.stateManager.updateSynthesisSession(this.currentSession.id, {
          state: ApplicationState.Error,
        });
      }

      // Always re-throw the error to maintain promise rejection behavior
      throw error;
    }
  }

  /**
   * Get available voices - expo-speech compatible
   */
  async getAvailableVoicesAsync(): Promise<EdgeSpeechVoice[]> {
    try {
      return await this.voiceService.getAvailableVoices();
    } catch (error) {
      console.error("Failed to get available voices:", error);
      return [];
    }
  }

  /**
   * Check if currently speaking - expo-speech compatible
   */
  async isSpeakingAsync(): Promise<boolean> {
    const audioState = this.audioService.currentState;
    return (
      audioState === AudioPlaybackState.Playing ||
      audioState === AudioPlaybackState.Loading ||
      (this.currentSession !== null &&
        (this.currentSession.state === ApplicationState.Synthesizing ||
          this.currentSession.state === ApplicationState.Playing))
    );
  }

  /**
   * Stop current speech synthesis and playback
   */
  async stop(): Promise<void> {
    if (this.currentSession) {
      try {
        // Use ConnectionManager to properly coordinate session termination
        // This ensures proper 3-layer architecture compliance and session cleanup
        await this.connectionManager.stopSynthesis(this.currentSession.id);

        // Remove current session via StateManager
        await this.stateManager.removeSynthesisSession(this.currentSession.id);
        this.currentSession = null;
      } catch (error) {
        // If ConnectionManager stop fails, fall back to direct cleanup
        console.warn(
          "ConnectionManager stop failed, performing direct cleanup:",
          error,
        );
        if (this.currentSession) {
          this.currentSession.state = ApplicationState.Idle;
          await this.audioService.stop();
          this.currentSession.options.onStopped?.();

          await this.stateManager.removeSynthesisSession(
            this.currentSession.id,
          );
          this.currentSession = null;
        }
      }
    }

    // Clear all queued sessions via StateManager
    const activeSessions = this.stateManager.getActiveSessions();
    for (const session of activeSessions) {
      await this.stateManager.removeSynthesisSession(session.id);
    }
    this.sessions.clear();
  }

  /**
   * Synthesize audio bytes WITHOUT playing them. Each audio frame received
   * from the Edge TTS WebSocket is forwarded synchronously to `onAudioChunk`
   * (if provided) before being collected into the merged buffer that the
   * Promise resolves with.
   *
   * Bypasses ConnectionManager/AudioService entirely — only NetworkService is
   * exercised — so callers don't fight audio cleanup races.
   */
  async synthesize(
    text: string,
    options: SpeechOptions = {},
    onAudioChunk?: SynthesisChunkListener,
  ): Promise<SynthesisResult> {
    if (!text || text.trim().length === 0) {
      throw new Error("Text cannot be empty");
    }

    const voice = await this.resolveVoice(options.voice, options.language);
    const ssml = generateSSML(text, {
      voice: voice.identifier,
      rate: options.rate,
      pitch: options.pitch,
      volume: options.volume,
      language: options.language || voice.language,
    });

    const sessionId = generateSessionId();
    const connectionId = generateConnectionId();

    const collected: Uint8Array[] = [];
    const aggregatingHook: SynthesisChunkListener = (chunk) => {
      collected.push(chunk);
      if (onAudioChunk) {
        try {
          onAudioChunk(chunk);
        } catch (err) {
          console.warn(
            "[Synthesizer] onAudioChunk listener threw:",
            err,
          );
        }
      }
    };

    const response = await this.networkService.synthesizeText(
      ssml,
      options,
      sessionId,
      connectionId,
      aggregatingHook,
    );

    const totalSize = collected.reduce((sum, c) => sum + c.length, 0);
    const merged = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of collected) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    return {
      audio: merged,
      durationMs: response.duration ?? 0,
    };
  }

  /**
   * Synthesize and write the result to disk as an MP3. If `filePath` is not
   * provided, a unique path under `FileSystem.cacheDirectory` is generated.
   */
  async synthesizeToFile(
    text: string,
    options: SpeechOptions = {},
    filePath?: string,
  ): Promise<SynthesisFileResult> {
    const { audio, durationMs } = await this.synthesize(text, options);

    const uri = filePath ?? this.makeTempAudioPath();

    let binaryString = "";
    for (let i = 0; i < audio.length; i++) {
      binaryString += String.fromCharCode(audio[i]!);
    }
    const base64 = btoa(binaryString);

    await FileSystem.writeAsStringAsync(uri, base64, {
      encoding: FileSystem.EncodingType.Base64,
    });

    return { uri, durationMs, size: audio.length };
  }

  private makeTempAudioPath(): string {
    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 8);
    return `${FileSystem.cacheDirectory}edge-tts-${ts}-${rand}.mp3`;
  }

  /**
   * Pause current playback
   */
  async pause(): Promise<void> {
    const timestamp = new Date().toISOString();
    console.log(
      `[${timestamp}] [Synthesizer] pause() called - has session: ${!!this.currentSession}, session state: ${this.currentSession?.state}`,
    );

    if (!this.currentSession) {
      console.log(
        `[${timestamp}] [Synthesizer] Pause skipped - no active session`,
      );
      return;
    }

    if (this.currentSession.state === ApplicationState.Playing) {
      console.log(
        `[${timestamp}] [Synthesizer] Pausing session via ConnectionManager`,
      );
      await this.connectionManager.pauseSynthesis(this.currentSession.id);
      console.log(
        `[${timestamp}] [Synthesizer] Session pause completed successfully`,
      );
    } else if (this.currentSession.state === ApplicationState.Paused) {
      console.log(
        `[${timestamp}] [Synthesizer] Session is already paused - no action needed`,
      );
    } else {
      console.log(
        `[${timestamp}] [Synthesizer] Pause not available - current state is ${this.currentSession.state} (requires Playing state)`,
      );
    }
  }

  /**
   * Resume paused playback
   */
  async resume(): Promise<void> {
    const timestamp = new Date().toISOString();
    console.log(
      `[${timestamp}] [Synthesizer] resume() called - has session: ${!!this.currentSession}, session state: ${this.currentSession?.state}`,
    );

    if (!this.currentSession) {
      console.log(
        `[${timestamp}] [Synthesizer] Resume skipped - no active session`,
      );
      return;
    }

    if (this.currentSession.state === ApplicationState.Paused) {
      console.log(
        `[${timestamp}] [Synthesizer] Resuming session via ConnectionManager`,
      );
      await this.connectionManager.resumeSynthesis(this.currentSession.id);
      console.log(
        `[${timestamp}] [Synthesizer] Session resume completed successfully`,
      );
    } else if (this.currentSession.state === ApplicationState.Playing) {
      console.log(
        `[${timestamp}] [Synthesizer] Session is already playing - no action needed`,
      );
    } else {
      console.log(
        `[${timestamp}] [Synthesizer] Resume not available - current state is ${this.currentSession.state} (requires Paused state)`,
      );
    }
  }

  /**
   * Create a new synthesis session using universal session ID format
   */
  private createSession(
    text: string,
    options: SpeechOptions,
  ): SynthesisSession {
    const sessionId = generateSessionId();
    const now = new Date();

    return {
      id: sessionId,
      connectionId: "", // Will be set when establishing connection
      text,
      options,
      state: ApplicationState.Idle,
      createdAt: now,
      lastActivity: now,
    };
  }

  /**
   * Process a synthesis session through the complete workflow
   */
  private async processSession(session: SynthesisSession): Promise<void> {
    try {
      this.currentSession = session;

      // Resolve voice for synthesis
      const voice = await this.resolveVoice(
        session.options.voice, // User-requested voice identifier (optional)
        session.options.language,
      );

      // Generate SSML at Synthesizer level per architecture.md
      const ssml = generateSSML(session.text, {
        voice: voice.identifier, // Resolved voice identifier
        rate: session.options.rate,
        pitch: session.options.pitch,
        volume: session.options.volume,
        language: session.options.language || voice.language,
      });

      // Update StateManager with the fact that synthesis has started
      await this.stateManager.updateSynthesisSession(session.id, {
        state: ApplicationState.Synthesizing,
      });

      // Also update the local session object
      session.state = ApplicationState.Synthesizing;

      // Use ConnectionManager to coordinate synthesis per architecture.md
      // ConnectionManager will handle NetworkService, StorageService, and AudioService coordination
      const connectionOptions = {
        voice: voice.identifier,
        ...session.options,
        clientSessionId: session.id,
        connectionId: session.connectionId,
      };

      await this.connectionManager.startSynthesis(ssml, connectionOptions);

      // The following lines were removed because they caused premature completion
      // notification. The onDone callback is now correctly handled by the
      // ConnectionManager and AudioService when playback is actually finished.
      // This fixes the issue where the "Stop" button was disabled while audio
      // was still playing.
    } catch (error) {
      this.handleSessionError(error, session.id);
    }
  }

  /**
   * Resolve voice for synthesis
   */
  private async resolveVoice(
    voiceId?: string,
    language?: string,
  ): Promise<EdgeSpeechVoice> {
    try {
      if (voiceId) {
        const voice = await this.voiceService.findVoiceByIdentifier(voiceId);
        if (voice) {
          return voice;
        }
      }

      // Fallback to language-based selection
      if (language) {
        const voices = await this.voiceService.getVoicesByLanguage(language);
        if (voices.length > 0) {
          return voices[0];
        }
      }

      // Final fallback to default voice
      const defaultVoices =
        await this.voiceService.getVoicesByLanguage("en-US");
      if (defaultVoices.length > 0) {
        return defaultVoices[0];
      }

      throw new Error("No suitable voice found");
    } catch (error) {
      throw new Error(
        `Voice resolution failed: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    }
  }

  /**
   * Process boundary events from synthesis
   */
  private processBoundaryEvents(
    session: SynthesisSession,
    boundaryData: WordBoundary[],
  ): void {
    if (!session.options.onBoundary) {
      return;
    }

    // Process boundary data and schedule callbacks with proper timing
    boundaryData.forEach((boundary) => {
      // The boundary data is already in the correct WordBoundary format
      // Schedule boundary callback - using charIndex as a rough timing estimate (in ms)
      const timing = boundary.charIndex * 100; // @FIXME: Adjust timing calculation as needed

      setTimeout(() => {
        session.options.onBoundary?.(boundary);
      }, timing);
    });
  }

  /**
   * Handle session completion
   */
  private handleSessionComplete(completed: boolean): void {
    if (this.currentSession) {
      this.currentSession.state = completed
        ? ApplicationState.Idle
        : ApplicationState.Idle;

      if (completed) {
        this.currentSession.options.onDone?.();
      } else {
        this.currentSession.options.onStopped?.();
      }

      // Clean up session
      this.sessions.delete(this.currentSession.id);
      this.currentSession = null;
    }

    // Update state if no more sessions
    if (this.sessions.size === 0) {
      // Sessions are tracked by StateManager - it will handle application state updates
      // through its session management and state coordination mechanisms
    }
  }

  /**
   * Handle session errors
   */
  private handleSessionError(error: any, sessionId?: string): void {
    const speechError: SpeechError = {
      name: "SynthesisError",
      code: "synthesis_error",
      message:
        error instanceof Error ? error.message : "Unknown synthesis error",
    };

    if (this.currentSession) {
      this.currentSession.options?.onError?.(speechError);
      const idToUpdate = sessionId || this.currentSession.id;
      this.stateManager.updateSynthesisSession(idToUpdate, {
        state: ApplicationState.Error,
      });
      if (this.currentSession.id === idToUpdate) {
        this.currentSession = null;
      }
    } else if (sessionId) {
      this.stateManager.updateSynthesisSession(sessionId, {
        state: ApplicationState.Error,
      });
    }

    console.error(`Session Error (${sessionId || "current"}):`, speechError);
  }

  /**
   * Get current synthesis status
   */
  getCurrentSession(): SynthesisSession | null {
    return this.currentSession;
  }

  /**
   * Get all active sessions
   */
  getAllSessions(): SynthesisSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Clear all sessions and reset synthesizer
   */
  async reset(): Promise<void> {
    await this.stop();
    this.sessions.clear();
    this.currentSession = null;
    // StateManager handles application state updates through the stop() method
    // which properly cleans up sessions via StateManager.removeSynthesisSession()
  }
}
