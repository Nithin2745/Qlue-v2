const { docClient } = require('../lib/dynamodb');
const { PutCommand, UpdateCommand, GetCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");
const { CloudWatchClient, PutMetricDataCommand } = require("@aws-sdk/client-cloudwatch");

const cloudwatch = new CloudWatchClient({});

const SESSIONS_TABLE = process.env.SESSIONS_TABLE || "Sessions";
const SESSIONS_TABLE_V2 = process.env.SESSIONS_TABLE_V2;

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

async function emitV2WriteFailureMetric(tableName) {
    try {
        await cloudwatch.send(new PutMetricDataCommand({
            Namespace: "Qlue/DatabaseMigration",
            MetricData: [{
                MetricName: "v2_write_failure",
                Dimensions: [{ Name: "TableName", Value: tableName }],
                Value: 1,
                Unit: "Count"
            }]
        }));
    } catch (e) {
        console.error("Failed to emit CloudWatch metric", e);
    }
}

async function dualWrite(oldWrite, newWrite, table, context) {
    await oldWrite();
    newWrite().catch(async (err) => {
        console.error('V2_WRITE_FAILED', { table, ...context, error: err.message, stack: err.stack });
        await emitV2WriteFailureMetric(table);
    });
}

/**
 * Creates a new interview session in DynamoDB.
 */
async function createSession(sessionId, userId, moduleType, itemData = {}) {
    const now = new Date().toISOString();
    const session = {
        sessionId,
        userId,
        moduleType,
        itemData, // [Mouli Week 4: Context Injection] Store resumeId/websiteUrl context
        voiceId: itemData.voiceId || 'Tiffany',
        currentState: INTERVIEW_STATES.INITIALIZING,
        turnCount: 0,
        startTime: now,
        updatedAt: now, // FIX: added
        silenceRetries: 0,
        accumulatedScores: {},
        version: 1,
        activeMarker: "ACTIVE" // Used for Sparse GSI pattern
    };

    const oldWrite = () => docClient.send(new PutCommand({
        TableName: SESSIONS_TABLE,
        Item: session,
    }));

    const newWrite = async () => {
        if (!SESSIONS_TABLE_V2) return;
        const sessionV2 = {
            ...session,
            sessionKey: `SESSION#${sessionId}`,
            startedAt: now,
            statusKey: `active#${now}` // sparse index SessionStatusIndex
        };
        await docClient.send(new PutCommand({
            TableName: SESSIONS_TABLE_V2,
            Item: sessionV2
        }));
    };

    await dualWrite(oldWrite, newWrite, 'SessionsTableV2', { sessionId, userId });
    return session;
}

/**
 * Retrieves a session by its ID.
 */
async function getSession(sessionId) {
    const command = new GetCommand({
        TableName: SESSIONS_TABLE,
        Key: { sessionId },
    });

    const response = await docClient.send(command);
    return response.Item;
}

/**
 * Sweeps the UserActiveIndex GSI to find any currently active session for a user.
 */
async function getActiveSessionForUser(userId) {
    const command = new QueryCommand({
        TableName: SESSIONS_TABLE,
        IndexName: 'UserActiveIndex',
        KeyConditionExpression: 'userId = :uid AND activeMarker = :am',
        ExpressionAttributeValues: {
            ':uid': userId,
            ':am': 'ACTIVE'
        },
        Limit: 1
    });

    const response = await docClient.send(command);
    return response.Items?.[0] || null;
}

/**
 * Updates the current state of the interview session, enforcing optimistic locking.
 */
async function updateSessionState(sessionId, newState, expectedCurrentState = null, updates = {}) {
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
        if (conditionExpression) {
            conditionExpression += " AND version = :expectedVersion";
        } else {
            conditionExpression = "version = :expectedVersion";
        }
        expressionAttributeValues[":expectedVersion"] = updates.expectedVersion;
    }

    if (updates.turnCount !== undefined) {
        updateExpression += ", turnCount = :turnCount";
        expressionAttributeValues[":turnCount"] = updates.turnCount;
    }

    if (updates.expectedTurnCount !== undefined) {
        if (conditionExpression) {
            conditionExpression += " AND turnCount = :expectedTurnCount";
        } else {
            conditionExpression = "turnCount = :expectedTurnCount";
        }
        expressionAttributeValues[":expectedTurnCount"] = updates.expectedTurnCount;
    }

    const now = new Date().toISOString();
    updateExpression += ", updatedAt = :updatedAt";
    expressionAttributeValues[":updatedAt"] = now;
    
    if (updates.silenceRetries !== undefined) {
        updateExpression += ", silenceRetries = :silenceRetries";
        expressionAttributeValues[":silenceRetries"] = updates.silenceRetries;
    }

    if (updates.accumulatedScores !== undefined) {
        updateExpression += ", accumulatedScores = :accumulatedScores";
        expressionAttributeValues[":accumulatedScores"] = updates.accumulatedScores;
    }

    if (updates.questionText !== undefined) {
        updateExpression += ", questionText = :questionText";
        expressionAttributeValues[":questionText"] = updates.questionText;
    }

    if (updates.currentConceptId !== undefined) {
        updateExpression += ", currentConceptId = :currentConceptId";
        expressionAttributeValues[":currentConceptId"] = updates.currentConceptId;
    }

    if (updates.scrapedSummary !== undefined) {
        updateExpression += ", scrapedSummary = :scrapedSummary";
        expressionAttributeValues[":scrapedSummary"] = updates.scrapedSummary;
    }
    
    // Cleanup active marker if terminated
    let removeExpression = "";
    if (newState === INTERVIEW_STATES.TERMINATED || newState === INTERVIEW_STATES.ERROR || newState === INTERVIEW_STATES.GENERATING_FEEDBACK) {
        removeExpression = " REMOVE activeMarker";
        if (updates.terminationReason) {
            updateExpression += ", terminationReason = :terminationReason";
            expressionAttributeValues[":terminationReason"] = updates.terminationReason;
        }
    }

    const command = new UpdateCommand({
        TableName: SESSIONS_TABLE,
        Key: { sessionId },
        UpdateExpression: updateExpression + removeExpression,
        ExpressionAttributeValues: expressionAttributeValues,
        ConditionExpression: conditionExpression,
        ReturnValues: "ALL_NEW"
    });

    // We do oldWrite inline so we can extract Attributes for newWrite
    let oldWriteResponse;
    const oldWrite = async () => {
        oldWriteResponse = await docClient.send(command);
    };

    const newWrite = async () => {
        if (!SESSIONS_TABLE_V2 || !oldWriteResponse?.Attributes) return;
        
        const attrs = oldWriteResponse.Attributes;
        
        // Convert UpdateExpression to V2 syntax. We can use same expressions 
        // with additional sparse index logic, or just write the returned attrs since it's a dual-write map.
        // It's safer and fully atomic to just write the new full item using PutCommand or UpdateCommand.
        // Wait, V2 has same fields, plus sessionKey, startedAt, statusKey, etc.
        // Since we have the FULL updated item from oldWrite, we can just PutCommand to V2 table.
        // BUT Wait! PutCommand overwrites the whole item. What if there are concurrent updates?
        // Since V2 is secondary right now, PutCommand with version condition is safer, or just UpdateCommand.
        // Actually, just mapping the UpdateCommand over to V2 is better.
        
        let v2UpdateExp = updateExpression + removeExpression;
        let v2ExpVals = { ...expressionAttributeValues };
        let v2Removes = [];
        
        if (newState === INTERVIEW_STATES.TERMINATED || newState === INTERVIEW_STATES.ERROR || newState === INTERVIEW_STATES.GENERATING_FEEDBACK) {
            v2Removes.push("statusKey");
            // Populate feedbackStatusKey if generating feedback
            if (newState === INTERVIEW_STATES.GENERATING_FEEDBACK) {
                v2UpdateExp += ", feedbackStatusKey = :fbsk";
                v2ExpVals[":fbsk"] = `pending#${now}`;
            }
        } else {
            v2UpdateExp += ", statusKey = :statusKey";
            v2ExpVals[":statusKey"] = `active#${now}`;
        }
        
        if (v2Removes.length > 0) {
            if (v2UpdateExp.includes("REMOVE")) {
                v2UpdateExp += ", " + v2Removes.join(", ");
            } else {
                v2UpdateExp += " REMOVE " + v2Removes.join(", ");
            }
        }

        await docClient.send(new UpdateCommand({
            TableName: SESSIONS_TABLE_V2,
            Key: { userId: attrs.userId, sessionKey: `SESSION#${sessionId}` },
            UpdateExpression: v2UpdateExp,
            ExpressionAttributeValues: v2ExpVals,
            ConditionExpression: conditionExpression // carry over optimistic locking
        }));
    };

    await dualWrite(oldWrite, newWrite, 'SessionsTableV2', { sessionId });
    return oldWriteResponse.Attributes;
}

module.exports = {
    INTERVIEW_STATES,
    createSession,
    getSession,
    updateSessionState,
    getActiveSessionForUser
};
