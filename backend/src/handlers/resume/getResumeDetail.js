const dynamodb = require('../../lib/dynamodb');
const RESUMES_TABLE = process.env.RESUMES_TABLE || 'Resumes';

const getResumeDetail = async (req, res) => {
    try {
        const userId = req.requestContext?.authorizer?.userId || req.user?.userId;
        if (!userId) {
            return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Missing authorizer context' });
        }

        const { resumeId } = req.params;
        if (!resumeId) {
            return res.status(400).json({ error: 'BAD_REQUEST', message: 'resumeId is required' });
        }

        const params = {
            TableName: RESUMES_TABLE,
            Key: {
                resumeId: resumeId
            }
        };

        const result = await dynamodb.get(params).promise();
        const resume = result.Item;

        if (!resume || resume.userId !== userId) {
            return res.status(404).json({ error: 'NOT_FOUND', message: 'Resume not found' });
        }

        return res.status(200).json({ resume });

    } catch (error) {
        console.error('Get Resume Detail Error:', error);
        return res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: error.message });
    }
};

module.exports = { getResumeDetail };
