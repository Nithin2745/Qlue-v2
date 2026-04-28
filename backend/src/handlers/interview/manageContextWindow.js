/**
 * Pass-through stub for managing context window.
 * TODO: Implement token-based truncation or summarization.
 */
module.exports = {
  manageContextWindow: async (sessionId, messages, maxAllowed = 10) => {
    if (!messages || messages.length <= maxAllowed) return messages;
    return [messages[0], ...messages.slice(-(maxAllowed - 1))];
  }
};
