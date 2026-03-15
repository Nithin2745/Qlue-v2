const dynamodb = require('../../lib/dynamodb');
const s3 = require('../../lib/s3');

const RESUMES_TABLE = process.env.RESUMES_TABLE || 'Resumes';
const USERS_TABLE = process.env.USERS_TABLE || 'qlue-users';
const BUCKET_NAME = process.env.RESUMES_BUCKET || 'qlue-resumes';

const deleteResume = async (req, res) => {
    try {
        const userId = req.requestContext?.authorizer?.userId || req.user?.userId;
        if (!userId) {
            return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Missing authorizer context' });
        }

        const { resumeId } = req.params;
        if (!resumeId) {
            return res.status(400).json({ error: 'BAD_REQUEST', message: 'resumeId is required' });
        }

        const getParams = {
            TableName: RESUMES_TABLE,
            Key: { resumeId: resumeId }
        };
        const getResult = await dynamodb.get(getParams).promise();
        const resume = getResult.Item;
        
        if (!resume || resume.userId !== userId) {
            return res.status(404).json({ error: 'NOT_FOUND', message: 'Resume not found' });
        }

        // Delete from S3
        if (resume.s3Key) {
            await s3.deleteObject({
                Bucket: BUCKET_NAME,
                Key: resume.s3Key
            }).promise();
        }

        // Delete from DynamoDB
        await dynamodb.delete({
            TableName: RESUMES_TABLE,
            Key: { resumeId: resumeId }
        }).promise();

        // If the deleted resume was active, set the next most recent one as active
        if (resume.isActive) {
            const queryParams = {
                TableName: RESUMES_TABLE,
                IndexName: 'GSI_UserIdUploadedAt',
                KeyConditionExpression: 'userId = :uid',
                ExpressionAttributeValues: { ':uid': userId },
                ScanIndexForward: false
            };
            const queryRes = await dynamodb.query(queryParams).promise();

            if (queryRes.Items && queryRes.Items.length > 0) {
                const mostRecent = queryRes.Items[0];
                
                await dynamodb.update({
                    TableName: RESUMES_TABLE,
                    Key: { resumeId: mostRecent.resumeId },
                    UpdateExpression: 'SET isActive = :trueVal',
                    ExpressionAttributeValues: { ':trueVal': true }
                }).promise();

                await dynamodb.update({
                    TableName: USERS_TABLE,
                    Key: { userId: userId },
                    UpdateExpression: 'SET activeResumeId = :rid',
                    ExpressionAttributeValues: { ':rid': mostRecent.resumeId }
                }).promise();
                
            } else {
                // No resumes left, remove activeResumeId from user
                await dynamodb.update({
                    TableName: USERS_TABLE,
                    Key: { userId: userId },
                    UpdateExpression: 'REMOVE activeResumeId',
                }).promise();
            }
        }

        return res.status(200).json({ message: 'Resume deleted successfully' });

    } catch (error) {
        console.error('Delete Resume Error:', error);
        return res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: error.message });
    }
};

module.exports = { deleteResume };
