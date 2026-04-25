const { docClient } = require('../lib/dynamodb');
const { PutCommand, UpdateCommand, GetCommand, QueryCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");

const RESUMES_TABLE = process.env.RESUMES_TABLE;

function getUserPk(userId) {
    return `USER#${userId}`;
}

/**
 * Creates a new resume record in V2.
 */
async function createResume(resumeData) {
    const uploadedAt = Date.now();
    const item = {
        ...resumeData,
        PK: getUserPk(resumeData.userId),
        SK: `RESUME#${uploadedAt}#${resumeData.resumeId}`,
        status: resumeData.status || 'PENDING',
        uploadedAt,
        isActive: false,
        resumeKey: `RESUME#${uploadedAt}#${resumeData.resumeId}`
    };

    await docClient.send(new PutCommand({
        TableName: RESUMES_TABLE,
        Item: item
    }));

    return { success: true };
}

/**
 * Retrieves a resume by ID from V2 using ResumeIdIndex GSI.
 */
async function getResumeById(resumeId) {
    const command = new QueryCommand({
        TableName: RESUMES_TABLE,
        IndexName: 'ResumeIdIndex',
        KeyConditionExpression: 'resumeId = :rid',
        ExpressionAttributeValues: { ':rid': resumeId },
        Limit: 1
    });
    const res = await docClient.send(command);
    return (res.Items && res.Items.length > 0) ? res.Items[0] : null;
}

/**
 * Retrieves a specific resume using the composite key.
 */
async function getResumeByUserIdAndKey(userId, resumeKey) {
    const command = new GetCommand({
        TableName: RESUMES_TABLE,
        Key: { PK: getUserPk(userId), SK: resumeKey }
    });
    const res = await docClient.send(command);
    return res.Item || null;
}

/**
 * Lists all resumes for a specific user from V2, newest first.
 */
async function getResumesByUserId(userId) {
    const command = new QueryCommand({
        TableName: RESUMES_TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: { ':pk': getUserPk(userId), ':prefix': 'RESUME#' },
        ScanIndexForward: false
    });
    const res = await docClient.send(command);
    return res.Items || [];
}

/**
 * Updates resume status and parsed data in V2.
 */
async function updateResumeParsingResult(userId, resumeKey, status, parsedData = null, failReason = null) {
    const now = new Date().toISOString();
    let updateExp = 'SET #st = :status, updatedAt = :ua';
    const values = { 
        ':status': status,
        ':ua': now
    };
    const names = { '#st': 'status' };

    if (parsedData) {
        updateExp += ', parsedData = :pd, parsedAt = :pa';
        values[':pd'] = parsedData;
        values[':pa'] = Date.now();
    }
    if (failReason) {
        updateExp += ', failReason = :fr';
        values[':fr'] = failReason;
    }

    const res = await docClient.send(new UpdateCommand({
        TableName: RESUMES_TABLE,
        Key: { PK: getUserPk(userId), SK: resumeKey },
        UpdateExpression: updateExp,
        ExpressionAttributeValues: values,
        ExpressionAttributeNames: names,
        ReturnValues: 'ALL_NEW'
    }));

    return { success: true, data: res.Attributes };
}

/**
 * Deletes a resume record from V2.
 */
async function deleteResumeRecord(userId, resumeKey) {
    await docClient.send(new DeleteCommand({
        TableName: RESUMES_TABLE,
        Key: { PK: getUserPk(userId), SK: resumeKey }
    }));
    return { success: true };
}

/**
 * Toggles the active status for a user's resumes in V2.
 */
async function toggleActiveStatus(userId, activeResumeId) {
    const resumes = await getResumesByUserId(userId);
    
    const updatePromises = resumes.map(r => {
        const shouldBeActive = r.resumeId === activeResumeId;
        const currentActiveKey = r.activeResumeKey;
        const targetActiveKey = shouldBeActive ? `ACTIVE#${activeResumeId}` : undefined;
        
        if (currentActiveKey !== targetActiveKey) {
            let updateExp = "SET isActive = :ia";
            let expVals = { ":ia": shouldBeActive };
            let removeExp = "";
            
            if (shouldBeActive) {
                updateExp += ", activeResumeKey = :ark";
                expVals[":ark"] = targetActiveKey;
            } else {
                removeExp = " REMOVE activeResumeKey";
            }
            
            return docClient.send(new UpdateCommand({
                TableName: RESUMES_TABLE,
                Key: { PK: getUserPk(r.userId), SK: r.resumeKey },
                UpdateExpression: updateExp + removeExp,
                ExpressionAttributeValues: expVals
            }));
        }
    }).filter(Boolean);

    await Promise.all(updatePromises);
}

/**
 * Retrieves the active resume for a user using V2 GSI.
 */
async function getActiveResume(userId) {
    const command = new QueryCommand({
        TableName: RESUMES_TABLE,
        IndexName: 'ActiveResumeIndex',
        KeyConditionExpression: 'userId = :uid AND begins_with(activeResumeKey, :prefix)',
        ExpressionAttributeValues: { ':uid': userId, ':prefix': 'ACTIVE#' }
    });
    const res = await docClient.send(command);
    return (res.Items && res.Items.length > 0) ? res.Items[0] : null;
}

module.exports = {
    createResume,
    getResumeById,
    getResumeByUserIdAndKey,
    getResumesByUserId,
    getActiveResume,
    updateResumeParsingResult,
    deleteResumeRecord,
    toggleActiveStatus
};
