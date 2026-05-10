const { invokeModel } = require('../../lib/bedrock');
const {
  buildVoiceInterviewPrompt,
  buildVoiceWebsiteTeachPrompt,
  buildVoiceHrPrompt,
  buildVoiceIntroPrompt,
  cleanAIResponse
} = require('../../lib/promptUtils');

const DEFAULT_BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID || 'anthropic.claude-3-sonnet-20240229-v1:0';

// =============================================================================
// MAIN HANDLER
// =============================================================================
exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body || '{}');
    const { sessionId, moduleType, resumeData, websiteContent, targetConcept, userData, turnIndex, conversationHistory, voiceId } = body;

    const aiName = voiceId || 'Emma';

    let prompt;
    switch (moduleType) {
      case 'WEBSITE':
        prompt = buildVoiceWebsiteTeachPrompt(websiteContent, targetConcept, turnIndex, conversationHistory, aiName);
        break;
      case 'HR':
        prompt = buildVoiceHrPrompt(userData, turnIndex, conversationHistory, aiName);
        break;
      case 'INTRO':
        prompt = buildVoiceIntroPrompt(turnIndex, conversationHistory, aiName);
        break;
      case 'RESUME':
      default:
        prompt = buildVoiceInterviewPrompt(resumeData, turnIndex, conversationHistory, moduleType, aiName);
        break;
    }

    const result = await invokeModel(DEFAULT_BEDROCK_MODEL_ID, {
      messages: [{ role: 'user', content: [{ text: prompt }] }]
    });
    const rawResponse = result.content?.[0]?.text || '';

    let cleanedResponse = cleanAIResponse(rawResponse);
    const namePrefixRegex = new RegExp(`^${aiName}:\\s*`, 'i');
    cleanedResponse = cleanedResponse.replace(namePrefixRegex, '');

    return {
      statusCode: 200,
      body: JSON.stringify({
        question: cleanedResponse
      })
    };
  } catch (error) {
    console.error('Generate Question Error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};

module.exports = {
  handler: exports.handler,
  buildInterviewPrompt: buildVoiceInterviewPrompt,
  buildWebsiteTeachPrompt: buildVoiceWebsiteTeachPrompt,
  buildHrPrompt: buildVoiceHrPrompt,
  buildIntroPrompt: buildVoiceIntroPrompt,
  cleanAIResponse
};
