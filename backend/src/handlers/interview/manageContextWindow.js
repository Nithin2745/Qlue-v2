/**
 * Pass-through stub for managing context window.
 * TODO: Implement token-based truncation or summarization.
 */
module.exports = {
  manageContextWindow: async (sessionId, messages, maxAllowed = 10) => {
    if (!messages || messages.length <= 6) return messages;
    return [messages[0], messages[1], ...messages.slice(-4)];
  }
};
