/**
 * Pass-through stub for managing context window.
 * TODO: Implement token-based truncation or summarization.
 */
module.exports = {
  manageContextWindow: async (sessionId, messages) => {
    // For now, just return messages as-is
    return messages;
  }
};
