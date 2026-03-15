const dynamodb = require('../../lib/dynamodb');

const RESUMES_TABLE = process.env.RESUMES_TABLE || 'Resumes';
const USERS_TABLE = process.env.USERS_TABLE || 'qlue-users';

const setActiveResume = async (req, res) => {
    try {
        const userId = req.requestContext?.authorizer?.userId || req.user?.userId;
        if (!userId) {
            return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Missing authorizer context' });
        }

        const { resumeId } = req.body;
        if (!resumeId) {
            return res.status(400).json({ error: 'BAD_REQUEST', message: 'resumeId is required' });
        }

        const getParams = {
            TableName: RESUMES_TABLE,
            Key: { resumeId: resumeId }
        };
        const getResult = await dynamodb.get(getParams).promise();
        const targetResume = getResult.Item;
        
        if (!targetResume || targetResume.userId !== userId) {
            return res.status(404).json({ error: 'NOT_FOUND', message: 'Resume not found' });
        }

        const queryParams = {
            TableName: RESUMES_TABLE,
            IndexName: 'GSI_UserIdUploadedAt',
            KeyConditionExpression: 'userId = :uid',
            ExpressionAttributeValues: { ':uid': userId }
        };
        const queryRes = await dynamodb.query(queryParams).promise();

        // Batch update isActive statuses
        const updatePromises = queryRes.Items.map(resume => {
            const isActive = resume.resumeId === resumeId;
            if (resume.isActive !== isActive) {
                return dynamodb.update({
                    TableName: RESUMES_TABLE,
                    Key: { resumeId: resume.resumeId },
                    UpdateExpression: 'SET isActive = :activeStr',
                    ExpressionAttributeValues: { ':activeStr': isActive }
                }).promise();
            }
        }).filter(Boolean);

        await Promise.all(updatePromises);

        // Update activeResumeId in user profile
        await dynamodb.update({
            TableName: USERS_TABLE,
            Key: { userId: userId },
            UpdateExpression: 'SET activeResumeId = :rid',
            ExpressionAttributeValues: { ':rid': resumeId }
        }).promise();

        return res.status(200).json({ message: 'Active resume updated successfully' });

    } catch (error) {
        console.error('Set Active Resume Error:', error);
        return res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: error.message });
    }
};

module.exports = { setActiveResume };
