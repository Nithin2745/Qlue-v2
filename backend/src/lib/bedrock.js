/**
 * Amazon Bedrock Client Wrapper specifically tuned for Qlue's Nemotron-4-340b-instruct pipeline.
 */
const { BedrockRuntimeClient, InvokeModelCommand, InvokeModelWithResponseStreamCommand } = require('@aws-sdk/client-bedrock-runtime');
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
 * Executes a Model Invocation with retries for Timeouts
 */
async function invokeModel(modelId = DEFAULT_MODEL_ID, body, options = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  
  const command = new InvokeModelCommand({
    body: payload,
    modelId: modelId,
    accept: 'application/json',
    contentType: 'application/json'
  });

  const maxRetries = options.retries || 2;
  let attempt = 0;

  while (attempt <= maxRetries) {
    try {
      const response = await bedrockClient.send(command);
      
      let responseBody = JSON.parse(Buffer.from(response.body).toString('utf-8'));
      
      // Normalize response format across models (Claude vs Nemotron)
      if (responseBody.choices && responseBody.choices[0].message) {
        responseBody.content = [{ text: responseBody.choices[0].message.content }];
      } else if (responseBody.choices && responseBody.choices[0].text) {
        responseBody.content = [{ text: responseBody.choices[0].text }];
      }

      if (options.logTokens) {
        // Log tokens usage
        console.info(`[Bedrock Tokens] Prompt: ${responseBody.usage?.prompt_tokens || '?'}, Completion: ${responseBody.usage?.completion_tokens || '?'}`);
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
async function invokeModelStream(modelId = DEFAULT_MODEL_ID, body, onToken) {
    const command = new InvokeModelWithResponseStreamCommand({
        body: JSON.stringify(body),
        modelId,
        contentType: 'application/json',
        accept: 'application/json'
    });

    try {
        const response = await bedrockClient.send(command);
        let fullText = "";
        let isTimedOut = false;
        
        let timeoutTimer = setTimeout(() => {
            isTimedOut = true;
        }, 15000);

        for await (const event of response.body) {
            if (isTimedOut) {
                throw new Error("BEDROCK_TIMEOUT");
            }
            // Reset timer on token received
            clearTimeout(timeoutTimer);
            timeoutTimer = setTimeout(() => {
                isTimedOut = true;
            }, 15000);

            const chunk = JSON.parse(new TextDecoder().decode(event.chunk.bytes));
            
            // Nemotron / OpenAI format
            if (chunk.choices && chunk.choices[0].delta?.content) {
                const token = chunk.choices[0].delta.content;
                fullText += token;
                if (onToken) onToken(token);
            } else if (chunk.choices && chunk.choices[0].text) {
                const token = chunk.choices[0].text;
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
  let systemContent = "";
  if (moduleType === 'RESUME') {
    systemContent = `You are an expert technical interviewer. You are conducting an interview based on the following candidate context:
${typeof context === 'object' ? JSON.stringify(context) : context}

Your goal is to ask one concise technical question.
Do not evaluate the previous answer. Just ask the next question and wait for the user to respond.
Return ONLY the question text, no JSON or extra formatting. Your response will be spoken directly to the user.`;
  } else if (moduleType === 'HR') {
    systemContent = `You are an HR recruiter.
Please ask one concise behavioral question using the STAR framework.
Do not evaluate the previous answer. Just ask the next question and wait for the user to respond.
Return ONLY the question text, no JSON or extra formatting. Your response will be spoken directly to the user.`;
  } else if (moduleType === 'SELF_INTRO') {
    systemContent = `You are an expert communication coach conducting a self-introduction exercise.
Ask one concise follow-up question regarding their introduction to probe deeper.
Do not evaluate the previous answer. Just ask the next question and wait for the user to respond.
Return ONLY the question text, no JSON or extra formatting. Your response will be spoken directly to the user.`;
  } else {
    systemContent = `You are an interviewer. Ask one concise question. Do not evaluate the answer. Wait for the user to respond.`;
  }

  return [
    { role: 'system', content: systemContent },
    ...history
  ];
}

/**
 * Builds the system prompt for Tutor Mode (WEBSITE)
 */
function buildTutorPrompt(websiteUrl, history, userAnswer) {
  return [
    { 
      role: 'system', 
      content: `You are a tutor. The user is learning about content from this website: ${websiteUrl}.
Check the user's answer for correctness. If it's incorrect or incomplete, explain their mistakes gently and provide the right approach. Then, ask the next question.
If they are correct, confirm it and proceed to the next concept.
Return ONLY your response text (the verification/guidance and the next question), no JSON or extra formatting. Your response will be spoken directly to the user.` 
    },
    ...history
  ];
}

/**
 * General scoring based on module dimensions
 */
function buildScoringPrompt(moduleType, transcript, dimensions) {
  return {
    messages: [
      {
        role: 'system',
        content: `You are an AI Interview evaluator analyzing a ${moduleType} interview session.
Please score the applicant across these dimensions: ${dimensions.join(', ')}.
Transcript:
${JSON.stringify(transcript)}

Format your output strictly as JSON mapping each dimension to a score between 1-100.`
      }
    ]
  };
}

/**
 * General qualitative feedback generation
 */
function buildFeedbackPrompt(moduleType, transcript, scores) {
  return {
    messages: [
      {
        role: 'system',
        content: `You are an AI Interview coach providing actionable feedback.
Review the following ${moduleType} session.
Scores: ${JSON.stringify(scores)}
Transcript: ${JSON.stringify(transcript)}

Provide 3 key strengths and 3 areas for improvement. Format as JSON: {"strengths": [], "improvements": []}`
      }
    ]
  };
}

/**
 * Concept extraction from scraped website content
 */
function buildConceptExtractionPrompt(content) {
  return {
    messages: [
      {
        role: 'system',
        content: `Act as a semantic parser. Extract the top 3-5 core concepts from this webpage text that a user should learn.
Text: ${content.substring(0, 5000)}

Format as JSON array of strings: {"concepts": ["concept1", "concept2"]}`
      }
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
  invokeModelStream
};
