const dynamodb = require('../../lib/dynamodb');
const s3 = require('../../lib/s3');
const textract = require('../../lib/textract');
const bedrock = require('../../lib/bedrock');

const RESUMES_TABLE = process.env.RESUMES_TABLE || 'Resumes';
const USERS_TABLE = process.env.USERS_TABLE || 'qlue-users';
const BUCKET_NAME = process.env.RESUMES_BUCKET || 'qlue-resumes';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

exports.handler = async (event) => {
    try {
        const s3Key = event.Records[0].s3.object.key;
        
        const parts = s3Key.split('/');
        if (parts.length < 3) throw new Error('Invalid S3 Key pattern');
        const userId = parts[1];

        // Find the record matching the S3 Key
        const queryParams = {
            TableName: RESUMES_TABLE,
            IndexName: 'GSI_UserIdUploadedAt',
            KeyConditionExpression: 'userId = :uid',
            ExpressionAttributeValues: { ':uid': userId }
        };
        const queryRes = await dynamodb.query(queryParams).promise();
        const resumeRecord = queryRes.Items.find(r => r.s3Key === s3Key);

        if (!resumeRecord) {
            console.error('No matching resume record found for S3 key:', s3Key);
            return;
        }

        const resumeId = resumeRecord.resumeId;

        // Update status to PARSING
        await dynamodb.update({
            TableName: RESUMES_TABLE,
            Key: { resumeId: resumeId },
            UpdateExpression: 'SET #st = :status',
            ExpressionAttributeNames: { '#st': 'status' },
            ExpressionAttributeValues: { ':status': 'PARSING' }
        }).promise();
        
        let jobId;
        let retries = 3;
        let delay = 1000;
        let textractStarted = false;
        
        // Handle Textract throttling with exponential backoff
        while (retries > 0 && !textractStarted) {
            try {
                const response = await textract.startDocumentAnalysis({
                    DocumentLocation: { S3Object: { Bucket: BUCKET_NAME, Name: s3Key } },
                    FeatureTypes: ['TABLES', 'KEY_VALUE_PAIRS']
                }).promise();
                jobId = response.JobId;
                textractStarted = true;
            } catch (err) {
                if (err.code === 'ProvisionedThroughputExceededException' || err.code === 'ThrottlingException') {
                    retries--;
                    if (retries === 0) throw err;
                    await sleep(delay);
                    delay *= 2;
                } else {
                    throw err;
                }
            }
        }

        // Wait for Textract completion
        let jobStatus;
        while (true) {
            await sleep(2000);
            const statusRes = await textract.getDocumentAnalysis({ JobId: jobId }).promise();
            jobStatus = statusRes.JobStatus;
            
            if (jobStatus === 'SUCCEEDED') {
                break;
            } else if (jobStatus === 'FAILED' || jobStatus === 'PARTIAL_SUCCESS') {
                throw new Error(`Textract Failed with status: ${jobStatus}`);
            }
        }

        // Collect all extracted blocks
        let nextToken = null;
        let allBlocks = [];
        do {
            const blocksRes = await textract.getDocumentAnalysis({ JobId: jobId, NextToken: nextToken }).promise();
            allBlocks = allBlocks.concat(blocksRes.Blocks);
            nextToken = blocksRes.NextToken;
        } while (nextToken);

        const fullText = allBlocks.filter(b => b.BlockType === 'LINE').map(b => b.Text).join('\n');
        
        // Validate extraction
        const wordCount = fullText.split(/\s+/).length;
        const textLower = fullText.toLowerCase();
        const keywords = ['experience', 'education', 'skills', 'projects'];
        const hasKeywords = keywords.some(k => textLower.includes(k));

        if (wordCount < 50 || !hasKeywords) {
            await dynamodb.update({
                TableName: RESUMES_TABLE,
                Key: { resumeId: resumeId },
                UpdateExpression: 'SET #st = :status, failReason = :reason',
                ExpressionAttributeNames: { '#st': 'status' },
                ExpressionAttributeValues: { 
                    ':status': 'FAILED',
                    ':reason': 'Text extraction yielded insufficient data or missing sections. Ensure the file is a proper resume.'
                }
            }).promise();
            return;
        }

        // Call Bedrock for structured extraction
        const prompt = `You are an AI resume parser. Extract the following information from the resume text into a strictly valid JSON object:
        {
          "name": "Full Name",
          "contact": { "email": "", "phone": "", "location": "" },
          "skills": ["skill1", "skill2"],
          "workExperience": [{ "company": "", "role": "", "duration": "", "highlights": [""] }],
          "projects": [{ "name": "", "technologies": [""], "description": "" }],
          "education": [{ "institution": "", "degree": "", "year": "" }],
          "certifications": [{ "name": "", "issuer": "", "year": "" }]
        }
        Return ONLY strictly valid JSON. Do not return markdown blocks or any explanation.

        Resume Text:
        ${fullText.substring(0, 100000)}`;

        const bedrockParams = {
            modelId: 'anthropic.claude-3-haiku-20240307-v1:0',
            contentType: 'application/json',
            accept: 'application/json',
            body: JSON.stringify({
                anthropic_version: "bedrock-2023-05-31",
                max_tokens: 4000,
                messages: [
                    { role: "user", content: prompt }
                ]
            })
        };

        const bedrockRes = await bedrock.invokeModel(bedrockParams).promise();
        const responseBody = JSON.parse(bedrockRes.body.toString('utf-8'));
        const responseText = responseBody.content[0].text;
        
        let parsedData = {};
        try {
            const jsonStr = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
            parsedData = JSON.parse(jsonStr);
        } catch (e) {
            throw new Error('Failed to parse Bedrock JSON response');
        }

        // Automatically set isActive if it's the first resume
        const isFirst = queryRes.Items.length === 1;

        await dynamodb.update({
            TableName: RESUMES_TABLE,
            Key: { resumeId: resumeId },
            UpdateExpression: 'SET #st = :status, parsedData = :pd, parsedAt = :pa, isActive = :ia',
            ExpressionAttributeNames: { '#st': 'status' },
            ExpressionAttributeValues: {
                ':status': 'PARSED',
                ':pd': parsedData,
                ':pa': Date.now(),
                ':ia': isFirst
            }
        }).promise();

        if (isFirst) {
            await dynamodb.update({
                TableName: USERS_TABLE,
                Key: { userId: userId },
                UpdateExpression: 'SET activeResumeId = :rid',
                ExpressionAttributeValues: { ':rid': resumeId }
            }).promise();
        }

    } catch (error) {
        console.error('Process Resume Upload Error:', error);
        
        try {
            if (event?.Records?.[0]?.s3?.object?.key) {
                const s3Key = event.Records[0].s3.object.key;
                const parts = s3Key.split('/');
                const userId = parts[1];
                
                const qParams = {
                    TableName: RESUMES_TABLE,
                    IndexName: 'GSI_UserIdUploadedAt',
                    KeyConditionExpression: 'userId = :uid',
                    ExpressionAttributeValues: { ':uid': userId }
                };
                const res = await dynamodb.query(qParams).promise();
                const rec = res.Items.find(r => r.s3Key === s3Key);
                
                if (rec) {
                    await dynamodb.update({
                        TableName: RESUMES_TABLE,
                        Key: { resumeId: rec.resumeId },
                        UpdateExpression: 'SET #st = :status, failReason = :reason',
                        ExpressionAttributeNames: { '#st': 'status' },
                        ExpressionAttributeValues: {
                            ':status': 'FAILED',
                            ':reason': error.message || 'Internal processing error'
                        }
                    }).promise();
                }
            }
        } catch (updateError) {
            console.error('Failed to update status to FAILED', updateError);
        }
    }
};
