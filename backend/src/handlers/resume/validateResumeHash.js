const dynamodb = require('../../lib/dynamodb');
const RESUMES_TABLE = process.env.RESUMES_TABLE || 'Resumes';

const validateResumeHash = async (req, res) => {
    try {
        const userId = req.requestContext?.authorizer?.userId || req.user?.userId;
        if (!userId) {
            return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Missing authorizer context' });
        }

        const { fileHash } = req.body;
        if (!fileHash) {
            return res.status(400).json({ error: 'BAD_REQUEST', message: 'fileHash is required' });
        }

        const params = {
            TableName: RESUMES_TABLE,
            IndexName: 'GSI_UserIdUploadedAt',
            KeyConditionExpression: 'userId = :uid',
            ExpressionAttributeValues: { ':uid': userId }
        };

        const queryRes = await dynamodb.query(params).promise();
        const duplicate = queryRes.Items.find(item => item.fileHash === fileHash);

        if (duplicate) {
            return res.status(200).json({
                isDuplicate: true,
                existingResumeId: duplicate.resumeId,
                existingFileName: duplicate.fileName,
                uploadedAt: duplicate.uploadedAt
            });
        }

        return res.status(200).json({
            isDuplicate: false,
            existingResumeId: null
        });

    } catch (error) {
        console.error('Validate Resume Hash Error:', error);
        return res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: error.message });
    }
};

module.exports = { validateResumeHash };
