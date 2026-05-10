const { extractResumeSummary, formatConversationHistory, cleanAIResponse } = require('../../src/lib/promptUtils');

describe('promptUtils', () => {
  describe('extractResumeSummary', () => {
    it('should extract summary from resume data', () => {
      const resumeData = {
        name: 'John Doe',
        title: 'Software Engineer',
        summary: 'Experienced developer',
        skills: ['JavaScript', 'Node.js'],
        experience: [
          { title: 'Senior Dev', company: 'Tech Inc', achievements: ['Built things'] }
        ]
      };
      const summary = extractResumeSummary(resumeData);
      expect(summary).toContain('Name: John Doe');
      expect(summary).toContain('Title: Software Engineer');
      expect(summary).toContain('Top Skills: JavaScript, Node.js');
      expect(summary).toContain('Senior Dev at Tech Inc');
    });

    it('should handle missing data', () => {
      expect(extractResumeSummary(null)).toBe('No resume data available.');
    });
  });

  describe('formatConversationHistory', () => {
    it('should format transcripts correctly', () => {
      const transcripts = [
        { speaker: 'AI', text: 'Hello', turnIndex: 0, timestamp: '2023-01-01T00:00:00Z' },
        { speaker: 'USER', text: 'Hi', turnIndex: 1, timestamp: '2023-01-01T00:00:01Z' }
      ];
      const formatted = formatConversationHistory(transcripts, 'Emma');
      expect(formatted).toContain('Emma (Interviewer): Hello');
      expect(formatted).toContain('Candidate: Hi');
    });
  });

  describe('cleanAIResponse', () => {
    it('should clean JSON and prefixes', () => {
      const raw = '{"question": "How are you?"}';
      expect(cleanAIResponse(raw)).toBe('How are you?');

      const prefixed = 'Emma: How are you?';
      expect(cleanAIResponse(prefixed)).toBe('How are you?');
    });
  });
});
