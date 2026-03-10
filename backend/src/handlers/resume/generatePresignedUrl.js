const crypto = require('crypto');
const dynamodb = require('../../lib/dynamodb');
const s3 = require('../../lib/s3');

const RESUMES_TABLE = process.env.RESUMES_TABLE || 'Resumes';
const BUCKET_NAME = process.env.RESUMES_BUCKET || 'qlue-resumes';

const generatePresignedUrl = async (req, res) => {
    try {
        const userId = req.requestContext?.authorizer?.userId || req.user?.userId;
        if (!userId) {
            return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Missing authorizer context' });
        }

        const { fileName, fileSize, fileHash } = req.body;

        if (!fileName || !fileSize || !fileHash) {
            return res.status(400).json({ error: 'BAD_REQUEST', message: 'Missing required fields' });
        }

        if (!fileName.toLowerCase().endsWith('.pdf')) {
            return res.status(400).json({ error: 'INVALID_FILE_TYPE', message: 'Only .pdf files are allowed. .doc and .docx are explicitly rejected.' });
        }

        if (fileSize > 5242880) {
            return res.status(400).json({ error: 'FILE_TOO_LARGE', message: 'File size exceeds 5MB limit' });
        }

        if (!/^[a-fA-F0-9]{64}$/.test(fileHash)) {
            return res.status(400).json({ error: 'INVALID_HASH', message: 'fileHash must be a valid SHA-256 hex string' });
        }

        // Check resume count
        const countParams = {
            TableName: RESUMES_TABLE,
            IndexName: 'GSI_UserIdUploadedAt',
            KeyConditionExpression: 'userId = :uid',
            ExpressionAttributeValues: {
                ':uid': userId
            },
            Select: 'COUNT'
        };
        const countResult = await dynamodb.query(countParams).promise();
        if (countResult.Count >= 4) {
            return res.status(409).json({ error: 'RESUME_LIMIT_EXCEEDED', message: 'Maximum of 4 resumes allowed' });
        }

        // Call validateResumeHash logic
        const hashParams = {
            TableName: RESUMES_TABLE,
            IndexName: 'GSI_UserIdUploadedAt',
            KeyConditionExpression: 'userId = :uid',
            ExpressionAttributeValues: {
                ':uid': userId
            }
        };
        const existingResumes = await dynamodb.query(hashParams).promise();
        const duplicate = existingResumes.Items.find(r => r.fileHash === fileHash);
        if (duplicate) {
            return res.status(409).json({ 
                error: 'DUPLICATE_RESUME', 
                message: 'A resume with this exact content already exists',
                existingResumeId: duplicate.resumeId 
            });
        }

        const resumeId = crypto.randomUUID();
        const timestamp = Date.now();
        const s3Key = `resumes/${userId}/${timestamp}_${fileName}`;

        const urlParams = {
            Bucket: BUCKET_NAME,
            Key: s3Key,
            Expires: 900,
            ContentType: 'application/pdf'
        };

        const uploadUrl = await s3.getSignedUrlPromise('putObject', urlParams);

        const newResume = {
            resumeId,
            userId,
            fileName,
            fileSize,
            fileHash,
            s3Key,
            status: 'UPLOADING',
            uploadedAt: timestamp,
            isActive: false
        };

        await dynamodb.put({
            TableName: RESUMES_TABLE,
            Item: newResume
        }).promise();

        return res.status(200).json({
            uploadUrl,
            resumeId,
            s3Key,
            expiresIn: 900
        });

    } catch (error) {
        console.error('Generate Presigned URL Error:', error);
        return res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: error.message });
    }
};

module.exports = { generatePresignedUrl };
