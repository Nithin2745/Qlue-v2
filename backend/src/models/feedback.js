const { docClient } = require('../lib/dynamodb');
const { UpdateCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");
const { randomUUID } = require('crypto');

const SESSIONS_TABLE = process.env.SESSIONS_TABLE || process.env.FEEDBACK_TABLE || 'qlue-core-v2';

/**
 * Creates and stores a new feedback report in V2.
 */
async function createFeedbackReport(data) {
    const feedbackId = randomUUID();
    const generatedAt = new Date().toISOString();
    const sessionLookup = await docClient.send(new QueryCommand({
        TableName: SESSIONS_TABLE,
        IndexName: 'SessionIdIndex',
        KeyConditionExpression: 'sessionId = :sid',
        ExpressionAttributeValues: { ':sid': data.sessionId },
        Limit: 1
    }));

    const session = sessionLookup.Items?.[0];
    if (!session) {
        throw new Error(`Session not found for feedback merge: ${data.sessionId}`);
    }

    const feedback = {
        feedbackId,
        sessionId: data.sessionId,
        userId: data.userId || session.userId,
        moduleType: data.moduleType || session.moduleType,
        overallScore: data.overallScore ?? null,
        strengths: data.strengths || [],
        weaknesses: data.weaknesses || data.improvements || [],
        improvements: data.improvements || data.weaknesses || [],
        executiveSummary: data.executiveSummary || data.summary || '',
        summary: data.summary || '',
        generatedAt
    };

    await docClient.send(new UpdateCommand({
        TableName: SESSIONS_TABLE,
        Key: { PK: session.PK, SK: session.SK },
        UpdateExpression: 'SET feedback = :feedback, feedbackId = :feedbackId, feedbackStatus = :feedbackStatus, feedbackStatusKey = :feedbackStatusKey, updatedAt = :updatedAt',
        ExpressionAttributeValues: {
            ':feedback': feedback,
            ':feedbackId': feedbackId,
            ':feedbackStatus': 'COMPLETE',
            ':feedbackStatusKey': `complete#${generatedAt}`,
            ':updatedAt': generatedAt
        },
        ReturnValues: 'ALL_NEW'
    }));

    return { success: true, feedbackId, data: feedback };
}

/**
 * Retrieves feedback by ID from V2 using GSI.
 */
async function getFeedbackById(feedbackId) {
    const command = new QueryCommand({
        TableName: SESSIONS_TABLE,
        IndexName: 'FeedbackIdIndex',
        KeyConditionExpression: 'feedbackId = :fid',
        ExpressionAttributeValues: { ':fid': feedbackId },
        Limit: 1
    });

    const res = await docClient.send(command);
    const session = res.Items?.[0] || null;
    return session?.feedback || null;
}

/**
 * Retrieves latest feedback for a user using V2 GSI.
 */
async function getLatestFeedbackForUser(userId) {
    const command = new QueryCommand({
        TableName: SESSIONS_TABLE,
        IndexName: 'UserSessionTimeIndex',
        KeyConditionExpression: 'userId = :uid',
        ExpressionAttributeValues: { ':uid': userId },
        ScanIndexForward: false
    });
    const res = await docClient.send(command);
    const session = (res.Items || []).find(item => item.feedback);
    return session?.feedback || null;
}

module.exports = {
    createFeedbackReport,
    getFeedbackById,
    getLatestFeedbackForUser
};
