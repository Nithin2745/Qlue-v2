const { docClient } = require('../lib/dynamodb');
const { PutCommand, UpdateCommand, GetCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");

const SESSIONS_TABLE = process.env.SESSIONS_TABLE;
const SESSION_PREFIX = 'SESSION#';

function getUserPk(userId) {
    return `USER#${userId}`;
}

const INTERVIEW_STATES = {
    INITIALIZING: "INITIALIZING",
    LOADING_CONTEXT: "LOADING_CONTEXT",
    AI_SPEAKING: "AI_SPEAKING",
    USER_RESPONDING: "USER_RESPONDING",
    PROCESSING_RESPONSE: "PROCESSING_RESPONSE",
    GENERATING_FEEDBACK: "GENERATING_FEEDBACK",
    SILENCE_DETECTED: "SILENCE_DETECTED",
    TERMINATED: "TERMINATED",
    ERROR: "ERROR"
};

/**
 * Creates a new interview session in V2 DynamoDB.
 */
async function createSession(sessionId, userId, moduleType, itemData = {}) {
    const now = new Date().toISOString();
    const session = {
        PK: getUserPk(userId),
        SK: `${SESSION_PREFIX}${sessionId}`,
        userId,
        sessionKey: `${SESSION_PREFIX}${sessionId}`,
        sessionId,
        moduleType,
        itemData, 
        voiceId: itemData.voiceId || 'Tiffany',
        currentState: INTERVIEW_STATES.INITIALIZING,
        turnCount: 0,
        startedAt: now,
        updatedAt: now,
        silenceRetries: 0,
        accumulatedScores: {},
        version: 1,
        statusKey: `active#${now}`,
        contextWindow: [],
        conceptStates: {}
    };

    await docClient.send(new PutCommand({
        TableName: SESSIONS_TABLE,
        Item: session,
    }));

    return session;
}

/**
 * Retrieves a session by its ID using V2 GSI.
 */
async function getSession(sessionId) {
    const command = new QueryCommand({
        TableName: SESSIONS_TABLE,
        IndexName: 'SessionIdIndex',
        KeyConditionExpression: 'sessionId = :sid',
        ExpressionAttributeValues: { ':sid': sessionId },
        Limit: 1
    });
    const res = await docClient.send(command);
    return (res.Items && res.Items.length > 0) ? res.Items[0] : null;
}

/**
 * Finds the currently active session for a user in V2.
 */
async function getActiveSessionForUser(userId) {
    const command = new QueryCommand({
        TableName: SESSIONS_TABLE,
        IndexName: 'SessionStatusIndex',
        KeyConditionExpression: 'userId = :uid AND begins_with(statusKey, :prefix)',
        ExpressionAttributeValues: { ':uid': userId, ':prefix': 'active#' },
        Limit: 1
    });
    const res = await docClient.send(command);
    return (res.Items && res.Items.length > 0) ? res.Items[0] : null;
}

/**
 * Updates the session state in V2, enforcing optimistic locking.
 */
async function updateSessionState(userId, sessionKey, newState, expectedCurrentState = null, updates = {}) {
    let updateExpression = "SET currentState = :newState, version = if_not_exists(version, :zero) + :one";
    const expressionAttributeValues = {
        ":newState": newState,
        ":zero": 0,
        ":one": 1
    };
    let conditionExpression = undefined;

    if (expectedCurrentState) {
        conditionExpression = "currentState = :expectedCurrentState";
        expressionAttributeValues[":expectedCurrentState"] = expectedCurrentState;
    }

    if (updates.expectedVersion !== undefined) {
        conditionExpression = conditionExpression ? `${conditionExpression} AND version = :expectedVersion` : "version = :expectedVersion";
        expressionAttributeValues[":expectedVersion"] = updates.expectedVersion;
    }

    const now = new Date().toISOString();
    updateExpression += ", updatedAt = :updatedAt";
    expressionAttributeValues[":updatedAt"] = now;
    
    const fields = [
        'silenceRetries', 'accumulatedScores', 'questionText', 
        'currentConceptId', 'scrapedSummary', 'contextWindow', 
        'conceptStates', 'feedbackStatus', 'feedbackStatusKey'
    ];

    fields.forEach(field => {
        if (updates[field] !== undefined) {
            updateExpression += `, ${field} = :${field}`;
            expressionAttributeValues[`:${field}`] = updates[field];
        }
    });
    
    let removeExpression = "";
    if (newState === INTERVIEW_STATES.TERMINATED || newState === INTERVIEW_STATES.ERROR || newState === INTERVIEW_STATES.GENERATING_FEEDBACK) {
        removeExpression = " REMOVE statusKey";
        if (updates.terminationReason) {
            updateExpression += ", terminationReason = :terminationReason";
            expressionAttributeValues[":terminationReason"] = updates.terminationReason;
        }
    } else {
        updateExpression += ", statusKey = :statusKey";
        expressionAttributeValues[":statusKey"] = `active#${now}`;
    }

    const res = await docClient.send(new UpdateCommand({
        TableName: SESSIONS_TABLE,
        Key: { PK: getUserPk(userId), SK: sessionKey },
        UpdateExpression: updateExpression + removeExpression,
        ExpressionAttributeValues: expressionAttributeValues,
        ConditionExpression: conditionExpression,
        ReturnValues: "ALL_NEW"
    }));

    return res.Attributes;
}

/**
 * Lists all sessions for a user from V2, newest first.
 */
async function getSessionsByUserId(userId, limit = 20) {
    const command = new QueryCommand({
        TableName: SESSIONS_TABLE,
        IndexName: 'UserSessionTimeIndex',
        KeyConditionExpression: 'userId = :uid',
        ExpressionAttributeValues: { ':uid': userId },
        ScanIndexForward: false,
        Limit: limit
    });
    const res = await docClient.send(command);
    return res.Items || [];
}

module.exports = {
    INTERVIEW_STATES,
    createSession,
    getSession,
    updateSessionState,
    getActiveSessionForUser,
    getSessionsByUserId
};
