const { getSession } = require('../../models/session');
const { getResumeById } = require('../../models/resume');
const { getUserById } = require('../../models/user');
const { getTranscriptBySession } = require('../../models/transcript');
const { invokeModel, buildResumeQuestionPrompt, buildHRQuestionPrompt, buildWebsiteTeachPrompt } = require('../../lib/bedrock');
const { success, internalError } = require('../../lib/response');

/**
 * AWS Lambda Handler: POST /interview/question
 * Generates the next AI question based on context.
 */
exports.handler = async (event) => {
    try {
        const { sessionId, moduleType, currentConceptId } = JSON.parse(event.body);
        
        const session = await getSession(sessionId);
        if (!session) {
            return internalError('Session not found');
        }

        const userId = session.userId;
        const turnCount = session.turnCount || 0;

        // 1. Fetch Conversation History (formatted for Bedrock)
        const transcripts = await getTranscriptBySession(sessionId);
        const history = transcripts.map(t => ({
            role: t.speaker === 'USER' ? 'user' : 'assistant',
            content: t.text
        }));

        let aiResponse = "";

        // 2. Branch based on interview module
        if (moduleType === 'RESUME') {
            // Get user's active resume to ground the questions
            const user = await getUserById(userId);
            const activeResumeId = user.activeResumeId;
            
            if (!activeResumeId) {
                aiResponse = "I haven't been able to load your technical profile. Let's start with a general introduction while I sync your data. Can you tell me a bit about your professional background?";
            } else {
                const resume = await getResumeById(activeResumeId);
                const parsedData = resume?.parsedData;

                if (!parsedData) {
                    aiResponse = "I've found your resume but I'm still processing the technical details. To get started, what are the top three technologies in your current stack?";
                } else {
                    // This is the core logic: Passing the FULL parsedData to Bedrock
                    const prompt = buildResumeQuestionPrompt(parsedData, history, turnCount);
                    
                    // Invoke Bedrock with Nemotron-4-340b
                    const bedrockResult = await invokeModel(undefined, { 
                        messages: prompt,
                        max_tokens: 500,
                        temperature: 0.7
                    });

                    // Extra layer of protection for response format
                    if (bedrockResult.content && bedrockResult.content[0]?.text) {
                        const rawContent = bedrockResult.content[0].text;
                        try {
                            // Bedrock might return raw JSON string as per system instructions
                            const parsed = JSON.parse(rawContent);
                            aiResponse = parsed.question || rawContent;
                        } catch (e) {
                            aiResponse = rawContent;
                        }
                    } else {
                        aiResponse = "That's interesting. Can you elaborate more on the technical challenges you faced in your most recent project?";
                    }
                }
            }
        } else if (moduleType === 'WEBSITE') {
            // ... Logic for website conceptual tutoring
            aiResponse = "Let's dive into the core concepts of the platform. What is your current understanding of the system architecture?";
        } else {
            // Default HR / Behavioral
            const prompt = buildHRQuestionPrompt("Professional Background", history);
            const bedrockResult = await invokeModel(undefined, { messages: prompt });
            aiResponse = bedrockResult.content?.[0]?.text || "Tell me about a time you faced a difficult problem and how you solved it.";
        }

        return success({ 
            aiResponse,
            state: session.currentState 
        });

    } catch (error) {
        console.error('Question Generation Error:', error);
        return internalError(error.message);
    }
};
