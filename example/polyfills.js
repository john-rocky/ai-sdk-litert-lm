// The AI SDK uses a few web APIs that React Native doesn't have.
// Import this file first, before anything else in the app runs.
import { Platform } from 'react-native'
import structuredClone from '@ungap/structured-clone'

if (Platform.OS !== 'web') {
  const {
    polyfillGlobal,
  } = require('react-native/Libraries/Utilities/PolyfillFunctions')
  const {
    TextEncoderStream,
    TextDecoderStream,
  } = require('@stardazed/streams-text-encoding')

  if (!('structuredClone' in global)) {
    polyfillGlobal('structuredClone', () => structuredClone)
  }
  polyfillGlobal('TextEncoderStream', () => TextEncoderStream)
  polyfillGlobal('TextDecoderStream', () => TextDecoderStream)
}

export {}
