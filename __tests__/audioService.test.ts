/**
 * Comprehensive test suite covering Audio Service functionality including:
 * - Integration with Storage Service and Audio Utilities
 * - Unified audio session configuration via expo-audio's setAudioModeAsync
 * - Audio session management and interruption handling
 * - Playback controls (play, pause, resume, stop)
 * - expo-speech compatible callbacks
 * - Error handling and resource management
 */

import { createAudioPlayer, setAudioModeAsync } from "expo-audio";
import { AudioService, AudioPlaybackState } from "../src/services/audioService";
import { StorageService } from "../src/services/storageService";
import type { SpeechOptions } from "../src/types";

// Mock expo-audio
jest.mock("expo-audio", () => ({
  createAudioPlayer: jest.fn(),
  setAudioModeAsync: jest.fn().mockResolvedValue(undefined),
}));

// Mock expo-file-system's legacy entry — that's where audioService imports from
// in SDK 55. The classic cacheDirectory/EncodingType/writeAsStringAsync API
// lives here now.
jest.mock("expo-file-system/legacy", () => ({
  cacheDirectory: "file:///cache/",
  writeAsStringAsync: jest.fn().mockResolvedValue(undefined),
  getInfoAsync: jest.fn().mockResolvedValue({ exists: true }),
  deleteAsync: jest.fn().mockResolvedValue(undefined),
  EncodingType: {
    Base64: "base64",
  },
}));

// Mock Audio Utilities
jest.mock("../src/utils/audioUtils", () => ({
  validateEdgeTTSMP3: jest.fn().mockReturnValue(true),
}));

type MockPlayer = {
  play: jest.Mock;
  pause: jest.Mock;
  seekTo: jest.Mock;
  remove: jest.Mock;
  replace: jest.Mock;
  addListener: jest.Mock;
};

/**
 * Build a mock player that auto-fires a "loaded" status update when a listener
 * is attached, so AudioService.loadAudio() resolves the same way it would
 * against a real expo-audio player.
 */
function createMockPlayer(
  options: { autoLoad?: boolean } = { autoLoad: true },
): MockPlayer {
  const player: MockPlayer = {
    play: jest.fn(),
    pause: jest.fn(),
    seekTo: jest.fn(),
    remove: jest.fn(),
    replace: jest.fn(),
    addListener: jest.fn(),
  };

  player.addListener.mockImplementation(
    (_event: string, cb: (status: any) => void) => {
      if (options.autoLoad) {
        // Defer so the awaiting Promise has a chance to register.
        setImmediate(() =>
          cb({
            isLoaded: true,
            playing: false,
            currentTime: 0,
            duration: 5,
            didJustFinish: false,
          }),
        );
      }
      return { remove: jest.fn() };
    },
  );

  return player;
}

describe("AudioService", () => {
  let audioService: AudioService;
  let storageService: StorageService;
  let mockPlayer: MockPlayer;
  let mockSpeechOptions: SpeechOptions;

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Mock the validateEdgeTTSMP3 function to return true by default
    const { validateEdgeTTSMP3 } = require("../src/utils/audioUtils");
    validateEdgeTTSMP3.mockReturnValue(true);

    mockPlayer = createMockPlayer();
    (createAudioPlayer as jest.Mock).mockReturnValue(mockPlayer);

    // Create mock storage service
    storageService = {
      getMergedAudioData: jest
        .fn()
        .mockReturnValue(new Uint8Array([72, 101, 108, 108, 111])), // "Hello" in bytes
      addAudioChunk: jest.fn().mockReturnValue(true),
      cleanupConnection: jest.fn().mockReturnValue(true),
    } as any;

    // Create audio service instance
    audioService = new AudioService(storageService);

    // Mock speech options
    mockSpeechOptions = {
      onStart: jest.fn(),
      onDone: jest.fn(),
      onStopped: jest.fn(),
      onPause: jest.fn(),
      onResume: jest.fn(),
      onError: jest.fn(),
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // =============================================================================
  // Constructor and Initialization Tests
  // =============================================================================

  describe("constructor and initialization", () => {
    it("should create AudioService instance with default configuration", () => {
      expect(audioService).toBeInstanceOf(AudioService);
      expect(audioService.currentState).toBe(AudioPlaybackState.Idle);
      expect(audioService.currentConnectionId).toBeNull();
    });

    it("should create AudioService with custom configuration", () => {
      const customConfig = {
        loadingTimeout: 10000,
        autoInitializeAudioSession: false,
      };
      const customAudioService = new AudioService(storageService, customConfig);
      expect(customAudioService).toBeInstanceOf(AudioService);
    });
  });

  // =============================================================================
  // Audio Session Management Tests
  // =============================================================================

  describe("audio session management", () => {
    it("should configure the audio session via setAudioModeAsync", async () => {
      await audioService.speak(mockSpeechOptions, "test-connection-1");

      expect(setAudioModeAsync).toHaveBeenCalledWith({
        playsInSilentMode: true,
        interruptionMode: "doNotMix",
        shouldPlayInBackground: false,
        shouldRouteThroughEarpiece: false,
      });
    });

    it("should not reinitialize audio session if already initialized", async () => {
      const freshAudioService = new AudioService(storageService);

      await freshAudioService.speak(mockSpeechOptions, "test-connection-1");
      await freshAudioService.speak(mockSpeechOptions, "test-connection-2");

      expect(setAudioModeAsync).toHaveBeenCalledTimes(1);
    });
  });

  // =============================================================================
  // Storage Service Integration Tests
  // =============================================================================

  describe("Storage Service integration", () => {
    it("should get merged audio data from Storage Service", async () => {
      const connectionId = "test-connection";
      await audioService.speak(mockSpeechOptions, connectionId);

      expect(storageService.getMergedAudioData).toHaveBeenCalledWith(
        connectionId,
      );
    });

    it("should handle empty audio data from Storage Service", async () => {
      (storageService.getMergedAudioData as jest.Mock).mockReturnValue(
        new Uint8Array(0),
      );

      await audioService.speak(mockSpeechOptions, "test-connection");

      expect(mockSpeechOptions.onError).toHaveBeenCalledWith({
        name: "AudioPlaybackError",
        message:
          "Audio playback failed: Error: No audio data available for playback",
        code: "AUDIO_PLAYBACK_FAILED",
      });
    });

    it("should cleanup connection in Storage Service on stop", async () => {
      await audioService.speak(mockSpeechOptions, "test-connection");
      await audioService.stop();

      expect(storageService.cleanupConnection).toHaveBeenCalledWith(
        "test-connection",
      );
    });
  });

  // =============================================================================
  // Audio Utilities Integration Tests
  // =============================================================================

  describe("Audio Utilities integration", () => {
    it("should validate MP3 format using Audio Utilities", async () => {
      const { validateEdgeTTSMP3 } = require("../src/utils/audioUtils");

      await audioService.speak(mockSpeechOptions, "test-connection");

      expect(validateEdgeTTSMP3).toHaveBeenCalled();
    });

    it("should handle invalid MP3 format", async () => {
      const { validateEdgeTTSMP3 } = require("../src/utils/audioUtils");
      validateEdgeTTSMP3.mockReturnValue(false);

      await audioService.speak(mockSpeechOptions, "test-connection");

      expect(mockSpeechOptions.onError).toHaveBeenCalledWith({
        name: "AudioPlaybackError",
        message: "Audio playback failed: Error: Invalid MP3 audio format",
        code: "AUDIO_PLAYBACK_FAILED",
      });
    });
  });

  // =============================================================================
  // Playback Control Tests
  // =============================================================================

  describe("playback controls", () => {
    beforeEach(async () => {
      await audioService.speak(mockSpeechOptions, "test-connection");
    });

    it("should start audio playback", async () => {
      expect(mockPlayer.play).toHaveBeenCalled();
      expect(audioService.currentState).toBe(AudioPlaybackState.Playing);
      expect(mockSpeechOptions.onStart).toHaveBeenCalled();
    });

    it("should pause audio playback", async () => {
      await audioService.pause();

      expect(mockPlayer.pause).toHaveBeenCalled();
      expect(audioService.currentState).toBe(AudioPlaybackState.Paused);
      // Note: onPause callback is handled by ConnectionManager, not AudioService
    });

    it("should resume audio playback", async () => {
      await audioService.pause();
      await audioService.resume();

      // Initial play + resume
      expect(mockPlayer.play).toHaveBeenCalledTimes(2);
      expect(audioService.currentState).toBe(AudioPlaybackState.Playing);
    });

    it("should stop audio playback", async () => {
      await audioService.stop();

      // expo-audio has no stopAsync; AudioService pauses + seeks to 0 then removes.
      expect(mockPlayer.pause).toHaveBeenCalled();
      expect(mockPlayer.seekTo).toHaveBeenCalledWith(0);
      expect(audioService.currentState).toBe(AudioPlaybackState.Stopped);
      expect(mockSpeechOptions.onStopped).toHaveBeenCalled();
    });

    it("should not pause if not playing", async () => {
      await audioService.stop();
      await audioService.pause();

      // pause was called once during stop(); no further calls from pause()
      expect(mockPlayer.pause).toHaveBeenCalledTimes(1);
    });

    it("should not resume if not paused", async () => {
      await audioService.resume();

      // Only the initial play call
      expect(mockPlayer.play).toHaveBeenCalledTimes(1);
    });
  });

  // =============================================================================
  // expo-speech Compatible Callback Tests
  // =============================================================================
  // Note: onPause and onResume callbacks are handled by ConnectionManager in the new architecture.
  // These tests focus on AudioService's state management and playback control responsibilities.

  describe("expo-speech compatible callbacks", () => {
    it("should trigger onStart callback when playback begins", async () => {
      await audioService.speak(mockSpeechOptions, "test-connection");

      expect(mockSpeechOptions.onStart).toHaveBeenCalled();
    });

    it("should trigger onDone callback when playback completes", async () => {
      await audioService.speak(mockSpeechOptions, "test-connection");

      // Simulate playback completion via the captured listener
      const statusUpdateCallback = mockPlayer.addListener.mock.calls[0][1];
      statusUpdateCallback({
        isLoaded: true,
        didJustFinish: true,
      });

      expect(mockSpeechOptions.onDone).toHaveBeenCalled();
    });

    it("should track Paused state when paused", async () => {
      await audioService.speak(mockSpeechOptions, "test-connection");
      await audioService.pause();

      expect(audioService.currentState).toBe(AudioPlaybackState.Paused);
      expect(mockPlayer.pause).toHaveBeenCalled();
    });

    it("should track Playing state when resumed", async () => {
      await audioService.speak(mockSpeechOptions, "test-connection");
      await audioService.pause();
      await audioService.resume();

      expect(audioService.currentState).toBe(AudioPlaybackState.Playing);
      expect(mockPlayer.play).toHaveBeenCalledTimes(2);
    });

    it("should trigger onStopped callback when stopped", async () => {
      await audioService.speak(mockSpeechOptions, "test-connection");
      await audioService.stop();

      expect(mockSpeechOptions.onStopped).toHaveBeenCalled();
    });

    it("should trigger onError callback on playback failure", async () => {
      mockPlayer.play.mockImplementationOnce(() => {
        throw new Error("Playback failed");
      });

      await audioService.speak(mockSpeechOptions, "test-connection");

      expect(mockSpeechOptions.onError).toHaveBeenCalled();
    });

    it("should not trigger callbacks if not set", async () => {
      const optionsWithoutCallbacks: SpeechOptions = {};

      await audioService.speak(optionsWithoutCallbacks, "test-connection");
      await audioService.pause();
      await audioService.resume();
      await audioService.stop();

      // Should not throw errors
      expect(true).toBe(true);
    });
  });

  // =============================================================================
  // Error Handling Tests
  // =============================================================================

  describe("error handling", () => {
    it("should handle Storage Service errors", async () => {
      (storageService.getMergedAudioData as jest.Mock).mockImplementation(
        () => {
          throw new Error("Storage error");
        },
      );

      await audioService.speak(mockSpeechOptions, "test-connection");

      expect(mockSpeechOptions.onError).toHaveBeenCalledWith({
        name: "AudioPlaybackError",
        message: "Audio playback failed: Error: Storage error",
        code: "AUDIO_PLAYBACK_FAILED",
      });
    });

    it("should handle expo-audio loading errors", async () => {
      (createAudioPlayer as jest.Mock).mockImplementationOnce(() => {
        throw new Error("Failed to load audio");
      });

      await audioService.speak(mockSpeechOptions, "test-connection");

      expect(mockSpeechOptions.onError).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "AudioPlaybackError",
          code: "AUDIO_PLAYBACK_FAILED",
        }),
      );
    });

    it("should handle pause errors gracefully", async () => {
      await audioService.speak(mockSpeechOptions, "test-connection");
      mockPlayer.pause.mockImplementationOnce(() => {
        throw new Error("Pause failed");
      });

      await audioService.pause();

      expect(mockSpeechOptions.onError).toHaveBeenCalledWith({
        name: "AudioPauseError",
        message: "Failed to pause audio: Error: Pause failed",
        code: "AUDIO_PAUSE_FAILED",
      });
    });

    it("should handle resume errors gracefully", async () => {
      await audioService.speak(mockSpeechOptions, "test-connection");
      await audioService.pause();
      mockPlayer.play.mockImplementationOnce(() => {
        throw new Error("Resume failed");
      });

      await audioService.resume();

      expect(mockSpeechOptions.onError).toHaveBeenCalledWith({
        name: "AudioResumeError",
        message: "Failed to resume audio: Error: Resume failed",
        code: "AUDIO_RESUME_FAILED",
      });
    });

    it("should handle stop errors without throwing", async () => {
      await audioService.speak(mockSpeechOptions, "test-connection");
      mockPlayer.pause.mockImplementationOnce(() => {
        throw new Error("Stop failed");
      });

      // Should not throw
      await expect(audioService.stop()).resolves.toBeUndefined();
    });
  });

  // =============================================================================
  // Resource Management Tests
  // =============================================================================

  describe("resource management", () => {
    it("should properly unload audio resources", async () => {
      const FileSystem = require("expo-file-system/legacy");
      await audioService.speak(mockSpeechOptions, "test-connection");
      await audioService.stop();

      expect(mockPlayer.remove).toHaveBeenCalled();

      // Should cleanup temporary file immediately after audio unload
      expect(FileSystem.getInfoAsync).toHaveBeenCalled();
      expect(FileSystem.deleteAsync).toHaveBeenCalled();
      expect(audioService.currentState).toBe(AudioPlaybackState.Stopped);
    });

    it("should clear connection ID on cleanup", async () => {
      await audioService.speak(mockSpeechOptions, "test-connection");
      expect(audioService.currentConnectionId).toBe("test-connection");

      await audioService.stop();
      expect(audioService.currentConnectionId).toBeNull();
    });

    it("should handle unload errors gracefully", async () => {
      await audioService.speak(mockSpeechOptions, "test-connection");
      mockPlayer.remove.mockImplementationOnce(() => {
        throw new Error("Unload failed");
      });

      // Should not throw
      await expect(audioService.stop()).resolves.toBeUndefined();
    });
  });

  // =============================================================================
  // State Management Tests
  // =============================================================================

  describe("state management", () => {
    it("should track playback state correctly", async () => {
      expect(audioService.currentState).toBe(AudioPlaybackState.Idle);
      expect(audioService.isPlaying).toBe(false);
      expect(audioService.isPaused).toBe(false);
      expect(audioService.isStopped).toBe(false);

      await audioService.speak(mockSpeechOptions, "test-connection");
      expect(audioService.currentState).toBe(AudioPlaybackState.Playing);
      expect(audioService.isPlaying).toBe(true);

      await audioService.pause();
      expect(audioService.currentState).toBe(AudioPlaybackState.Paused);
      expect(audioService.isPaused).toBe(true);

      await audioService.stop();
      expect(audioService.currentState).toBe(AudioPlaybackState.Stopped);
      expect(audioService.isStopped).toBe(true);
    });

    it("should handle playback status updates", async () => {
      await audioService.speak(mockSpeechOptions, "test-connection");

      const statusUpdateCallback = mockPlayer.addListener.mock.calls[0][1];

      statusUpdateCallback({
        isLoaded: true,
        didJustFinish: true,
      });

      expect(audioService.currentState).toBe(AudioPlaybackState.Completed);
    });

    it("should handle interruptions", async () => {
      await audioService.speak(mockSpeechOptions, "test-connection");

      const statusUpdateCallback = mockPlayer.addListener.mock.calls[0][1];

      // Simulate genuine interruption: stopped mid-playback after >100ms.
      statusUpdateCallback({
        isLoaded: true,
        playing: false,
        didJustFinish: false,
        currentTime: 0.15, // 150ms — past the startup threshold
        duration: 5, // 5s of audio
      });

      expect(audioService.currentState).toBe(AudioPlaybackState.Paused);
    });

    it("should filter out false positive interruptions during startup", async () => {
      await audioService.speak(mockSpeechOptions, "test-connection");

      const statusUpdateCallback = mockPlayer.addListener.mock.calls[0][1];

      // Simulate false positive during startup: position below 100ms threshold.
      statusUpdateCallback({
        isLoaded: true,
        playing: false,
        didJustFinish: false,
        currentTime: 0.05, // 50ms — should be filtered as startup transient
        duration: 5,
      });

      expect(audioService.currentState).toBe(AudioPlaybackState.Playing);
    });
  });

  // =============================================================================
  // Streamed Audio Playback Tests
  // =============================================================================

  describe("streamed audio playback", () => {
    it("should play streamed audio from Storage Service", async () => {
      await audioService.playStreamedAudio("stream-connection");

      expect(storageService.getMergedAudioData).toHaveBeenCalledWith(
        "stream-connection",
      );
      expect(mockPlayer.play).toHaveBeenCalled();
      expect(audioService.currentConnectionId).toBe("stream-connection");
    });

    it("should handle empty streamed audio data", async () => {
      (storageService.getMergedAudioData as jest.Mock).mockReturnValue(
        new Uint8Array(0),
      );

      const originalOnError = jest.fn();
      (audioService as any).onErrorCallback = originalOnError;

      await audioService.playStreamedAudio("stream-connection");

      expect(originalOnError).toHaveBeenCalledWith({
        name: "StreamedAudioError",
        message:
          "Streamed audio playback failed: Error: No audio data available for playback",
        code: "STREAMED_AUDIO_FAILED",
      });
    });
  });

  // =============================================================================
  // Pause/Resume Independent of Platform
  // =============================================================================

  describe("pause/resume", () => {
    it("should pause and resume regardless of platform", async () => {
      await audioService.speak(mockSpeechOptions, "test-connection-android");

      await audioService.pause();
      expect(mockPlayer.pause).toHaveBeenCalled();
      expect(audioService.currentState).toBe(AudioPlaybackState.Paused);

      await audioService.resume();
      expect(mockPlayer.play).toHaveBeenCalledTimes(2); // initial + resume
      expect(audioService.currentState).toBe(AudioPlaybackState.Playing);
    });
  });

  // =============================================================================
  // Temporary File Implementation Tests
  // =============================================================================

  describe("temporary file creation and cleanup", () => {
    it("should create temporary file and load audio successfully", async () => {
      const FileSystem = require("expo-file-system/legacy");

      await audioService.speak(mockSpeechOptions, "test-connection");

      // Should write to temporary file
      expect(FileSystem.writeAsStringAsync).toHaveBeenCalled();

      // Should create audio player from file URI
      const writeCall = (FileSystem.writeAsStringAsync as jest.Mock).mock
        .calls[0];
      const fileUri = writeCall[0];
      expect(fileUri).toMatch(/^file:\/\/\/cache\/audio_\d+_[a-z0-9]+\.mp3$/);

      expect(createAudioPlayer).toHaveBeenCalledWith(fileUri);
    });

    it("should clean up temporary file on stop", async () => {
      const FileSystem = require("expo-file-system/legacy");

      await audioService.speak(mockSpeechOptions, "test-connection");
      await audioService.stop();

      expect(FileSystem.getInfoAsync).toHaveBeenCalled();
      expect(FileSystem.deleteAsync).toHaveBeenCalled();
    });

    it("should handle base64 encoding correctly", async () => {
      const FileSystem = require("expo-file-system/legacy");
      const testData = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"

      storageService.getMergedAudioData = jest.fn().mockReturnValue(testData);

      await audioService.speak(mockSpeechOptions, "test-connection");

      const writeCall = (FileSystem.writeAsStringAsync as jest.Mock).mock
        .calls[0];
      const [, base64Data, options] = writeCall;

      expect(options.encoding).toBe("base64");
      expect(base64Data).toBe(btoa("Hello"));
    });

    it("should handle file creation errors gracefully", async () => {
      const FileSystem = require("expo-file-system/legacy");
      // Use *Once* — jest.clearAllMocks() doesn't reset implementations, so
      // a persistent rejection here would poison every subsequent test that
      // calls speak() / playStreamedAudio().
      FileSystem.writeAsStringAsync.mockRejectedValueOnce(
        new Error("File write failed"),
      );

      await audioService.speak(mockSpeechOptions, "test-connection");

      expect(mockSpeechOptions.onError).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "AudioPlaybackError",
          message: expect.stringContaining(
            "Failed to create temporary audio file",
          ),
          code: "AUDIO_PLAYBACK_FAILED",
        }),
      );
    });

    it("should handle cleanup errors gracefully", async () => {
      const FileSystem = require("expo-file-system/legacy");
      // *Once* so we don't bleed the rejected state into later tests.
      FileSystem.deleteAsync.mockRejectedValueOnce(new Error("Delete failed"));

      await audioService.speak(mockSpeechOptions, "test-connection");

      // Should not throw when cleanup fails
      await expect(audioService.stop()).resolves.not.toThrow();
    });
  });

  describe("file-based audio integration", () => {
    it("should work with playStreamedAudio", async () => {
      const FileSystem = require("expo-file-system/legacy");

      const { validateEdgeTTSMP3 } = require("../src/utils/audioUtils");
      validateEdgeTTSMP3.mockReturnValue(true);

      (storageService.getMergedAudioData as jest.Mock).mockReturnValue(
        new Uint8Array([72, 101, 108, 108, 111]), // "Hello"
      );

      await audioService.playStreamedAudio("stream-connection");

      expect(FileSystem.writeAsStringAsync).toHaveBeenCalled();
      expect(mockPlayer.play).toHaveBeenCalled();
    });

    it("should validate MP3 format before creating file", async () => {
      const { validateEdgeTTSMP3 } = require("../src/utils/audioUtils");
      validateEdgeTTSMP3.mockReturnValue(false);

      await audioService.speak(mockSpeechOptions, "test-connection");

      expect(mockSpeechOptions.onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("Invalid MP3 audio format"),
        }),
      );
    });

    it("should trigger callbacks correctly with file-based approach", async () => {
      await audioService.speak(mockSpeechOptions, "test-connection");

      expect(mockSpeechOptions.onStart).toHaveBeenCalled();
      expect(audioService.currentState).toBe(AudioPlaybackState.Playing);
    });
  });
});
