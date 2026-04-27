---
id: intro
title: Getting Started
description: Get started with expo-edge-speech for high-quality text-to-speech synthesis
slug: /
---

# Getting Started with expo-edge-speech

**expo-edge-speech** is a text-to-speech library for Expo and React Native applications that provides high-quality voice synthesis using Microsoft's Edge TTS service. It offers a drop-in replacement for expo-speech with enhanced features including 400+ natural voices, better voice quality, word boundary events, and cross-platform support for both iOS and Android.

## Features

- **Drop-in replacement** for expo-speech with identical API
- **Enhanced voice quality** through Microsoft Edge TTS service
- **400+ natural voices** with multilingual support
- **Cross-platform pause/resume** support (including Android)
- **Word boundary events** for real-time text highlighting
- **Advanced configuration** for performance optimization
- **Comprehensive error handling** and recovery mechanisms

## Installation

### For Expo Projects

```bash
npm install expo-edge-speech
```

### For React Native Projects

React Native projects need Expo to use this library (and its dependencies):

```bash
# Install Expo (if not already installed)
npm install expo@sdk-55

# Install the library
npm install expo-edge-speech
```

### Requirements

- **Expo SDK 55** or higher
- **iOS 15.1+** / **Android API 24+**
- **React Native 0.83+**

## Quick Start

```typescript
import * as Speech from 'expo-edge-speech';

// Basic text-to-speech
await Speech.speak('Hello world');

// With options
await Speech.speak('Welcome to my app!', {
  voice: 'en-US-AriaNeural',
  rate: 1.2,
  onDone: () => console.log('Speech completed')
});
```

## What's Next?

- 📚 [**API Reference**](./api-reference) - Complete function documentation and core concepts
- 🎯 [**Usage Examples**](./usage-examples) - Practical examples and common patterns
- ⚙️ [**Configuration Guide**](./configuration) - Setup and performance optimization
- 📱 [**Platform Considerations**](./platform-considerations) - iOS/Android specific requirements
- 🔧 [**TypeScript Interfaces**](./typescript-interfaces) - Type definitions and interfaces

## Platform Support

- **iOS:** 15.1+ (Expo SDK 55+)
- **Android:** API 24+ (Expo SDK 55+)
- **React Native:** 0.83+

## License

This project is licensed under the MIT License.