const dynamodb = require('../../lib/dynamodb');
const RESUMES_TABLE = process.env.RESUMES_TABLE || 'Resumes';

const updateResumeParsedData = async (req, res) => {
    try {
        const userId = req.requestContext?.authorizer?.userId || req.user?.userId;
        if (!userId) {
            return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Missing authorizer context' });
        }

        const { resumeId } = req.params;
        if (!resumeId) {
            return res.status(400).json({ error: 'BAD_REQUEST', message: 'resumeId is required' });
        }

        const updates = req.body;
        if (!updates || Object.keys(updates).length === 0) {
            return res.status(400).json({ error: 'BAD_REQUEST', message: 'No fields provided for update' });
        }

        // Verify ownership
        const getParams = {
            TableName: RESUMES_TABLE,
            Key: { resumeId: resumeId }
        };
        const getResult = await dynamodb.get(getParams).promise();
        const resume = getResult.Item;
        
        if (!resume || resume.userId !== userId) {
            return res.status(404).json({ error: 'NOT_FOUND', message: 'Resume not found' });
        }

        if (resume.status !== 'PARSED' || !resume.parsedData) {
            return res.status(400).json({ error: 'BAD_REQUEST', message: 'Resume is not in a valid parsed state for updates' });
        }

        let updateExpression = 'SET parsedAt = :now';
        const expressionAttributeNames = {};
        const expressionAttributeValues = {
            ':now': Date.now()
        };

        Object.keys(updates).forEach((key, index) => {
            const attrName = `#field${index}`;
            const attrVal = `:val${index}`;
            
            updateExpression += `, parsedData.${attrName} = ${attrVal}`;
            expressionAttributeNames[attrName] = key;
            expressionAttributeValues[attrVal] = updates[key];
        });

        const updateParams = {
            TableName: RESUMES_TABLE,
            Key: { resumeId: resumeId },
            UpdateExpression: updateExpression,
            ExpressionAttributeNames: expressionAttributeNames,
            ExpressionAttributeValues: expressionAttributeValues,
            ReturnValues: 'ALL_NEW'
        };

        const updateResult = await dynamodb.update(updateParams).promise();

        return res.status(200).json({
            message: 'Resume parsedData updated successfully',
            updatedFields: updates,
            updatedAt: updateResult.Attributes.parsedAt,
            parsedData: updateResult.Attributes.parsedData
        });

    } catch (error) {
        console.error('Update Resume Parsed Data Error:', error);
        return res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: error.message });
    }
};

module.exports = { updateResumeParsedData };
