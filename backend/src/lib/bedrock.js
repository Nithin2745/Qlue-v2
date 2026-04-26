/**
 * Amazon Bedrock Client Wrapper specifically tuned for Qlue's Nemotron-4-340b-instruct pipeline.
 */
const { BedrockRuntimeClient, ConverseCommand, ConverseStreamCommand } = require('@aws-sdk/client-bedrock-runtime');
const { NodeHttpHandler } = require('@smithy/node-http-handler');
const { getBedrockConfig } = require('./secrets');
const { ERROR_CODES, QlueError } = require('./errors');

const bedrockClient = new BedrockRuntimeClient({ 
  region: process.env.AWS_REGION || 'us-east-1',
  requestHandler: new NodeHttpHandler({
    connectionTimeout: 5000,
    requestTimeout: 15000
  })
});

// The required Model ID
const DEFAULT_MODEL_ID = process.env.BEDROCK_MODEL_ID || 'nvidia.nemotron-super-3-120b';

/**
 * Executes a Model Invocation using Converse API
 */
async function invokeModel(modelId = DEFAULT_MODEL_ID, params, options = {}) {
  const systemPrompt = "You are Qlue, an elite technical interviewer.";
  
  const command = new ConverseCommand({
    modelId: modelId,
    messages: params.messages || [],
    system: params.system ? [{ text: params.system }] : [{ text: systemPrompt }],
    inferenceConfig: {
      maxTokens: params.max_tokens || 1000,
      temperature: params.temperature || 0.7,
      topP: 0.9
    }
  });

  const maxRetries = options.retries || 2;
  let attempt = 0;

  while (attempt <= maxRetries) {
    try {
      const response = await bedrockClient.send(command);
      
      // Standardize response format
      const responseBody = {
        content: [{ text: response.output.message.content[0].text }],
        usage: response.usage
      };

      if (options.logTokens) {
        console.info(`[Bedrock Tokens] Input: ${responseBody.usage?.inputTokens || '?'}, Output: ${responseBody.usage?.outputTokens || '?'}`);
      }

      return responseBody;
    } catch (error) {
      attempt++;
      if (error.name === 'ModelTimeoutException' || error.name === 'ThrottlingException' || error.$metadata?.httpStatusCode === 429) {
        if (attempt > maxRetries) {
          throw new QlueError('Bedrock Timeout after retries', ERROR_CODES.BEDROCK_TIMEOUT, 504, error.message);
        }
        await new Promise(res => setTimeout(res, attempt * 1000));
        continue;
      }
      throw new QlueError('Bedrock Invocation Error', ERROR_CODES.BEDROCK_ERROR, 500, error.message);
    }
  }
}

/**
 * Executes a Model Invocation with Streaming Output for low latency
 * @param {string} modelId 
 * @param {object} body 
 * @param {function} onToken Callback for each received token
 */
async function invokeModelStream(modelId = DEFAULT_MODEL_ID, params, onToken) {
    const systemPrompt = "You are Qlue, an elite technical interviewer.";

    const command = new ConverseStreamCommand({
        modelId,
        messages: params.messages || [],
        system: params.system ? [{ text: params.system }] : [{ text: systemPrompt }],
        inferenceConfig: {
            maxTokens: params.max_tokens || 1000,
            temperature: params.temperature || 0.7,
            topP: 0.9
        }
    });

    try {
        const response = await bedrockClient.send(command);
        let fullText = "";
        let isTimedOut = false;
        
        let timeoutTimer = setTimeout(() => {
            isTimedOut = true;
        }, 15000);

        for await (const event of response.stream) {
            if (isTimedOut) {
                throw new Error("BEDROCK_TIMEOUT");
            }
            // Reset timer on token received
            clearTimeout(timeoutTimer);
            timeoutTimer = setTimeout(() => {
                isTimedOut = true;
            }, 15000);

            if (event.contentBlockDelta) {
                const token = event.contentBlockDelta.delta.text;
                fullText += token;
                if (onToken) onToken(token);
            }
        }
        clearTimeout(timeoutTimer);
        return fullText;
    } catch (error) {
        console.error('Bedrock Streaming Error:', error);
        if (error.message === 'BEDROCK_TIMEOUT' || error.name === 'TimeoutError') {
            throw new QlueError('Bedrock stream timed out after 15 seconds of inactivity.', 'BEDROCK_TIMEOUT', 504, error.message);
        }
        throw new QlueError('Bedrock Streaming Error', 'BEDROCK_ERROR', 500, error.message);
    }
}


/**
 * Builds the system prompt for Interview Modes (RESUME, HR, SELF_INTRO)
 */
function buildInterviewPrompt(context, history, turnCount, moduleType) {
  // Shared constraint for all prompts
  const sharedConstraints = `\nNEVER use markdown, bullet points, or numbered lists. Write ONLY spoken text as if talking to someone face-to-face. Max 40 words per response. NEVER evaluate previous answers. NEVER include meta-commentary like "Great question" or "Let me think".`;

  let systemContent = "";
  if (moduleType === 'RESUME') {
    // Determine question type based on turn count for variety
    const questionTypes = ['depth', 'experience', 'problem-solving'];
    const questionType = questionTypes[turnCount % questionTypes.length];
    
    systemContent = `You are an expert technical interviewer. You are conducting an interview based on the following candidate resume:\n${typeof context === 'object' ? JSON.stringify(context) : context}\n\nInstructions:\n- Reference SPECIFIC items from the resume (projects, technologies, roles, companies).\n- This turn's question type: ${questionType}.\n  - "depth": Probe deeper into a specific technology or project mentioned.\n  - "experience": Ask about a real-world scenario they faced in a listed role.\n  - "problem-solving": Present a technical challenge related to their listed skills.\n- Ask exactly one concise question.\n- Return ONLY the question text. Your response will be spoken directly to the user.${sharedConstraints}`;
  } else if (moduleType === 'HR') {
    // Progress through behavioral topics based on turn count
    const hrTopics = ['teamwork', 'problem-solving', 'leadership', 'conflict resolution', 'adaptability'];
    const currentTopic = hrTopics[turnCount % hrTopics.length];
    
    systemContent = `You are an HR recruiter conducting a behavioral interview.\nCurrent topic: ${currentTopic}.\n\nInstructions:\n- Ask one concise behavioral question about ${currentTopic} using the STAR framework.\n- Progress naturally: teamwork → problem-solving → leadership → conflict resolution → adaptability.\n- Return ONLY the question text. Your response will be spoken directly to the user.${sharedConstraints}`;
  } else if (moduleType === 'SELF_INTRO') {
    systemContent = `You are an expert communication coach conducting a self-introduction exercise.\nAsk one concise follow-up question regarding their introduction to probe deeper.\nReturn ONLY the question text. Your response will be spoken directly to the user.${sharedConstraints}`;
  } else {
    systemContent = `You are an interviewer. Ask one concise question. Wait for the user to respond.${sharedConstraints}`;
  }

  return {
    system: systemContent,
    messages: [
      ...history,
      { role: 'user', content: [{ text: turnCount === 0 ? "Let's begin the interview." : "Please ask the next question." }] }
    ]
  };
}

/**
 * Builds the system prompt for Tutor Mode (WEBSITE)
 */
function buildTutorPrompt(websiteUrl, history, userAnswer) {
  return {
    system: `You are a tutor. The user is learning about content from this website: ${websiteUrl}.
Check the user's answer for correctness. If it's incorrect or incomplete, explain their mistakes gently and provide the right approach. Then, ask the next question.
If they are correct, confirm it and proceed to the next concept.
Return ONLY your response text (the verification/guidance and the next question), no JSON or extra formatting. Your response will be spoken directly to the user.`,
    messages: [
      ...history,
      { role: 'user', content: [{ text: userAnswer ? `My answer: ${userAnswer}` : "Let's begin." }] }
    ]
  };
}

/**
 * General scoring based on module dimensions
 */
function buildScoringPrompt(moduleType, latestResponse, dimensions) {
  return {
    system: `You are an AI Interview evaluator analyzing a ${moduleType} interview session.\nScore ONLY the following latest response (do NOT consider previous turns):\n"${typeof latestResponse === 'string' ? latestResponse : JSON.stringify(latestResponse)}"\n\nDimensions to evaluate: ${dimensions.join(', ')}.\n\nFormat your output strictly as JSON mapping each dimension to a score between 1-100. No markdown, no explanation, just the JSON object.`,
    messages: [
      {
        role: 'user',
        content: [{ text: "Score ONLY the latest response above across the listed dimensions." }]
      }
    ]
  };
}

/**
 * General qualitative feedback generation
 */
function buildFeedbackPrompt(moduleType, transcript, scores) {
  return {
    system: `You are an AI Interview coach providing actionable feedback.
Review the following ${moduleType} session.
Scores: ${JSON.stringify(scores)}
Transcript: ${JSON.stringify(transcript)}

Provide 3 key strengths and 3 areas for improvement. Format as JSON: {"strengths": [], "improvements": []}`,
    messages: [
      {
        role: 'user',
        content: [{ text: "Please provide constructive feedback based on the scores and transcript." }]
      }
    ]
  };
}

/**
 * Concept extraction from scraped website content
 */
function buildConceptExtractionPrompt(content) {
  return {
    system: `Act as a semantic parser. Extract the top 3-5 core concepts from this webpage text that a user should learn.
Text: ${content.substring(0, 5000)}

Format as JSON array of strings: {"concepts": ["concept1", "concept2"]}`,
    messages: [
      {
        role: 'user',
        content: [{ text: "Extract concepts from the provided text." }]
      }
    ]
  };
}

function buildResumeQuestionPrompt(resumeData, history, turnCount) {
  const systemContent = `You are Qlue, an elite technical interviewer. You are conducting an interview based on the following resume data:
${typeof resumeData === 'object' ? JSON.stringify(resumeData) : resumeData}

Instructions:
- Ask exactly one concise technical question.
- Do not evaluate the previous answer.
- Focus on specific technologies or projects mentioned in the resume.
- Return ONLY the question text (or a JSON with "question" field if required by the caller).`;

  const messages = [
    ...history,
    { role: 'user', content: [{ text: turnCount === 0 ? "Let's begin the interview." : "Generate the next technical question." }] }
  ];
  return { system: systemContent, messages };
}

function buildHRQuestionPrompt(context, history) {
  const systemContent = `You are an HR recruiter. Ask one concise behavioral question using the STAR framework. Do not evaluate the previous answer.`;
  const messages = [
    ...history,
    { role: 'user', content: [{ text: "Generate the next behavioral question." }] }
  ];
  return { system: systemContent, messages };
}

function buildWebsiteTeachPrompt(targetConcept, content, history, isEvaluation) {
  const systemContent = `You are a tutor helping a student learn about ${targetConcept} from this content:
${content.substring(0, 5000)}

Instructions:
- If isEvaluation is true, check the last answer and provide feedback.
- Ask a follow-up question to test understanding.
- Return response as JSON: {"response": "your feedback and next question", "isCorrect": true/false}`;

  const messages = [
    ...history,
    { role: 'user', content: [{ text: isEvaluation ? "Evaluate my response and ask the next question." : `Introduce ${targetConcept} and ask a question.` }] }
  ];
  return { system: systemContent, messages };
}

function buildSelfIntroEvalPrompt(transcript) {
  return {
    system: "You are an expert communication coach. Evaluate the self-introduction provided.",
    messages: [
      { role: 'user', content: [{ text: `Introduction to evaluate: ${transcript}` }] }
    ]
  };
}

module.exports = {
  invokeModel,
  buildInterviewPrompt,
  buildTutorPrompt,
  buildScoringPrompt,
  buildFeedbackPrompt,
  buildConceptExtractionPrompt,
  buildResumeQuestionPrompt,
  buildHRQuestionPrompt,
  buildWebsiteTeachPrompt,
  buildSelfIntroEvalPrompt,
  invokeModelStream
};
