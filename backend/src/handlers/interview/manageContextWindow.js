/**
 * Pass-through stub for managing context window.
 * TODO: Implement token-based truncation or summarization.
 */
module.exports = {
  manageContextWindow: async (sessionId, messages, maxAllowed = 10) => {
    if (!messages || messages.length <= 6) return messages;
    
    const firstPart = [messages[0], messages[1]];
    const targetRole = messages[1].role === 'user' ? 'assistant' : 'user';
    
    let candidateSlice = messages.slice(-4);
    if (candidateSlice[0].role !== targetRole) {
      if (messages.length >= 7) {
        candidateSlice = messages.slice(-5);
      } else {
        candidateSlice = messages.slice(-3);
      }
    }
    
    return [...firstPart, ...candidateSlice];
  }
};
