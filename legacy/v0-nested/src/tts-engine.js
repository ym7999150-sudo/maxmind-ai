// ============================================================================
// MuxMind AI — src/tts-engine.js
// Text-To-Speech Controller (Arabic & English Synthesis)
// This module exposes server-side helpers; actual speech synthesis runs
// client-side via the Web Speech API (SpeechSynthesis) for zero-latency,
// zero-cost voice output. This file provides language detection + voice
// preference resolution consumed by ui-render.js on the client.
// ============================================================================

function detectLanguage(text = "") {
  const arabicPattern = /[\u0600-\u06FF]/;
  return arabicPattern.test(text) ? "ar" : "en";
}

/**
 * Returns a preferred voice config the client should request from
 * window.speechSynthesis.getVoices().
 */
function resolveVoicePreference(mode, text) {
  // mode: 'mute' | 'auto' | 'ar' | 'en'
  if (mode === "mute") return null;
  if (mode === "ar") return { lang: "ar-SA", rate: 1.0, pitch: 1.0 };
  if (mode === "en") return { lang: "en-US", rate: 1.0, pitch: 1.0 };

  // auto: detect from text
  const detected = detectLanguage(text);
  return detected === "ar"
    ? { lang: "ar-SA", rate: 1.0, pitch: 1.0 }
    : { lang: "en-US", rate: 1.0, pitch: 1.0 };
}

/** Strips markdown/code fences so TTS doesn't read out symbols. */
function sanitizeForSpeech(text = "") {
  return text
    .replace(/```[\s\S]*?```/g, " (code block) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[*_#>~-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

module.exports = { detectLanguage, resolveVoicePreference, sanitizeForSpeech };
