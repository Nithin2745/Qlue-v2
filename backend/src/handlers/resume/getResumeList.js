const dynamodb = require('../../lib/dynamodb');
const RESUMES_TABLE = process.env.RESUMES_TABLE || 'Resumes';

const getResumeList = async (req, res) => {
    try {
        const userId = req.requestContext?.authorizer?.userId || req.user?.userId;
        if (!userId) {
            return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Missing authorizer context' });
        }

        const params = {
            TableName: RESUMES_TABLE,
            IndexName: 'GSI_UserIdUploadedAt',
            KeyConditionExpression: 'userId = :uid',
            ExpressionAttributeValues: {
                ':uid': userId
            },
            ScanIndexForward: false // Return newest first
        };

        const result = await dynamodb.query(params).promise();
        
        // Map to exclude parsedData for smaller payload
        const resumes = result.Items.map(item => ({
            resumeId: item.resumeId,
            fileName: item.fileName,
            fileSize: item.fileSize,
            status: item.status,
            uploadedAt: item.uploadedAt,
            parsedAt: item.parsedAt,
            isActive: item.isActive,
            failReason: item.failReason || null
        }));

        return res.status(200).json({
            resumes: resumes,
            count: resumes.length,
            maxAllowed: 4
        });

    } catch (error) {
        console.error('Get Resume List Error:', error);
        return res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: error.message });
    }
};

module.exports = { getResumeList };
