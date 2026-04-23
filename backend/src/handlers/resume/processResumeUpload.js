const { query, update } = require('../../lib/dynamodb');
const textractClient = require('../../lib/textract');
const { invokeModel } = require('../../lib/bedrock');
const { 
    StartDocumentAnalysisCommand, 
    GetDocumentAnalysisCommand 
} = require("@aws-sdk/client-textract");
const { updateResumeParsingResult, getResumesByUserId, getResumeById } = require('../../models/resume');
const { setActiveResumeId } = require('../../models/user');
const { success, badRequest, notFound, internalError, unauthorized } = require('../../lib/response');

const RESUMES_TABLE = process.env.RESUMES_TABLE || 'qlue-resumes';
const BUCKET_NAME = process.env.RESUMES_BUCKET || 'qlue-resumes';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * AWS Lambda Handler: POST /resume/process
 * 
 * Responds immediately with 202 Accepted, then processing runs in the background.
 * The frontend polls /resume/detail to get the final status.
 */
exports.handler = async (event) => {
    let resumeRecord = null;
    let userId = null;

    try {
        if (!event.body) return badRequest('Missing request body');
        const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
        const { resumeId } = body;
        
        if (!resumeId) return badRequest('resumeId is required');

        userId = event.requestContext?.authorizer?.uid;
        if (!userId) return unauthorized('Unauthorized access: Missing user ID');

        // 1. Find the database record matching this resumeId
        resumeRecord = await getResumeById(resumeId);

        if (!resumeRecord) {
            console.error('No matching resume record found for ID:', resumeId);
            return notFound('Resume not found');
        }
        
        if (resumeRecord.userId !== userId) {
            return unauthorized('User does not own this resume');
        }
        
        const s3Key = resumeRecord.s3Key;

        // 2. Update status to PARSING immediately, so the UI can reflect it
        await updateResumeParsingResult(resumeId, 'PARSING');

        // 3. Return 202 Accepted immediately — processing continues asynchronously
        //    The Lambda keeps running after the response is sent (in Lambda environments).
        //    For local Express dev, we use setImmediate to detach.
        processAsync(resumeId, userId, s3Key).catch(err => {
            console.error(`Background processing failed for ${resumeId}:`, err.message);
        });

        return success({ 
            resumeId, 
            status: 'PARSING', 
            message: 'Resume received and parsing started.' 
        }, 202);

    } catch (error) {
        console.error('Process Resume Upload Error:', error);
        if (resumeRecord) {
            await updateResumeParsingResult(resumeRecord.resumeId, 'FAILED', null, error.message);
        }
        return internalError(error.message);
    }
};

/**
 * Runs Textract + Bedrock in the background.
 * Updates DynamoDB directly with results.
 */
async function processAsync(resumeId, userId, s3Key) {
    try {
        // Wait a moment to ensure the S3 object is fully available
        await sleep(1500);
        
        // Start Textract Async Analysis
        const startCommand = new StartDocumentAnalysisCommand({
            DocumentLocation: { S3Object: { Bucket: BUCKET_NAME, Name: s3Key } },
            FeatureTypes: ['TABLES', 'FORMS']
        });
        const startRes = await textractClient.send(startCommand);
        const jobId = startRes.JobId;
        console.info(`Textract started for resumeId=${resumeId}, jobId=${jobId}`);

        // Poll for Textract completion — no API Gateway timeout here since we already returned
        let jobStatus = 'IN_PROGRESS';
        let attempts = 0;
        const maxAttempts = 30; // 30 * 5s = 2.5 minutes max

        while (jobStatus === 'IN_PROGRESS' && attempts < maxAttempts) {
            await sleep(5000);
            attempts++;
            const getCommand = new GetDocumentAnalysisCommand({ JobId: jobId });
            const statusRes = await textractClient.send(getCommand);
            jobStatus = statusRes.JobStatus;
            console.info(`Textract status for ${resumeId}: ${jobStatus} (attempt ${attempts})`);
        }

        if (jobStatus !== 'SUCCEEDED') {
            throw new Error(`Textract job did not succeed. Final status: ${jobStatus}`);
        }

        // Collect all text blocks
        let nextToken = null;
        let fullText = '';
        do {
            const pageRes = await textractClient.send(new GetDocumentAnalysisCommand({ 
                JobId: jobId, 
                NextToken: nextToken 
            }));
            fullText += (pageRes.Blocks || [])
                .filter(b => b.BlockType === 'LINE')
                .map(b => b.Text)
                .join('\n') + '\n';
            nextToken = pageRes.NextToken;
        } while (nextToken);

        console.info(`Textract extracted ${fullText.split(/\s+/).length} words for ${resumeId}`);

        // Validate extraction quality
        const wordCount = fullText.split(/\s+/).length;
        if (wordCount < 30) {
            await updateResumeParsingResult(resumeId, 'FAILED', null, 'Insufficient text extracted from document.');
            return;
        }

        // Call Bedrock to structure the data
        const parsedData = await invokeBedrockParser(fullText);

        // Update final result in DynamoDB
        await updateResumeParsingResult(resumeId, 'PARSED', parsedData);
        console.info(`Successfully parsed resume ${resumeId}`);

        // Auto-set as active if it's the only resume
        const allResumes = await getResumesByUserId(userId);
        if (allResumes.length === 1) {
            await setActiveResumeId(userId, resumeId);
            await update(RESUMES_TABLE, { resumeId }, 'SET isActive = :ia', { ':ia': true });
            console.info(`Auto-set resume ${resumeId} as active for user ${userId}`);
        }

    } catch (error) {
        console.error(`processAsync error for resumeId=${resumeId}:`, error.message);
        await updateResumeParsingResult(resumeId, 'FAILED', null, error.message);
    }
}

/**
 * Helper to invoke Claude 3 / Nemotron via Bedrock for resume parsing.
 */
async function invokeBedrockParser(text) {
    const prompt = `You are an AI resume parser. Extract the following information from the resume text into a strictly valid JSON object:
    {
      "name": "Full Name",
      "contact": { "email": "", "phone": "", "location": "" },
      "skills": ["skill1", "skill2"],
      "workExperience": [{ "company": "", "role": "", "duration": "", "highlights": [""] }],
      "projects": [{ "name": "", "technologies": [""], "description": "" }],
      "education": [{ "institution": "", "degree": "", "year": "" }]
    }
    Return ONLY strictly valid JSON. Do not return markdown formatted blocks (\`\`\`json).
    
    Resume Text:
    ${text.substring(0, 50000)}`;

    const body = {
        messages: [{ role: "user", content: prompt }],
        max_tokens: 4000,
        temperature: 0.1
    };

    const response = await invokeModel(process.env.BEDROCK_MODEL_ID, body);
    
    // Normalize response - bedrock.js already normalizes to content[0].text
    let rawText = '';
    if (response.content && response.content[0] && response.content[0].text) {
        rawText = response.content[0].text;
    } else if (response.choices && response.choices[0]) {
        rawText = response.choices[0].message?.content || response.choices[0].text || '';
    } else {
        rawText = JSON.stringify(response);
    }
    
    try {
        return JSON.parse(rawText.trim());
    } catch (e) {
        console.error("JSON parse failed, attempting manual clean:", rawText.substring(0, 200));
        const cleaned = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
        return JSON.parse(cleaned);
    }
}
