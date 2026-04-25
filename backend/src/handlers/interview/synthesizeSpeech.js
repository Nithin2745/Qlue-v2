/**
 * Stub for legacy speech synthesis.
 * Note: Real-time synthesis is currently handled in sendTextHandler.js via lib/polly.js.
 */
module.exports = {
  synthesizeSpeech: async (text, options = {}) => {
    // TODO: Implement standalone synthesis if needed for non-WebSocket flows
    return {
      audioUrl: null,
      message: "Synthesis stub called. Use WebSocket for real-time audio."
    };
  }
};
