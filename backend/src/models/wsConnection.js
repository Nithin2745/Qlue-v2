const { docClient } = require('../lib/dynamodb');
const { PutCommand, UpdateCommand, GetCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");

const WS_CONNECTIONS_TABLE = process.env.WS_CONNECTIONS_TABLE;

/**
 * Register a new connection or update existing in V2.
 */
async function saveConnection(connectionId, userId, sessionId = null) {
    const now = Date.now();
    const item = {
        userId,
        connectionKey: `CONN#${now}#${connectionId}`,
        connectionId,
        sessionId,
        isActive: 'true',
        connectedAt: now,
        lastHeartbeat: now,
        ttl: Math.floor(now / 1000) + 7200 // 2 hours
    };

    await docClient.send(new PutCommand({
        TableName: WS_CONNECTIONS_TABLE,
        Item: item
    }));

    return { success: true };
}

/**
 * Deactivate a connection by ID in V2.
 */
async function deactivateConnection(userId, connectionKey) {
    await docClient.send(new UpdateCommand({
        TableName: WS_CONNECTIONS_TABLE,
        Key: { userId, connectionKey },
        UpdateExpression: 'SET isActive = :val',
        ExpressionAttributeValues: { ':val': 'false' }
    }));
    return { success: true };
}

/**
 * Update heartbeat timestamp in V2.
 */
async function updateHeartbeat(userId, connectionKey) {
    const now = Date.now();
    await docClient.send(new UpdateCommand({
        TableName: WS_CONNECTIONS_TABLE,
        Key: { userId, connectionKey },
        UpdateExpression: 'SET lastHeartbeat = :ts',
        ExpressionAttributeValues: { ':ts': now }
    }));
    return { success: true };
}

/**
 * Associate a session ID with a connection in V2.
 */
async function associateSession(userId, connectionKey, sessionId) {
    await docClient.send(new UpdateCommand({
        TableName: WS_CONNECTIONS_TABLE,
        Key: { userId, connectionKey },
        UpdateExpression: 'SET sessionId = :sid',
        ExpressionAttributeValues: { ':sid': sessionId }
    }));
    return { success: true };
}

/**
 * Get connection by connectionId using V2 GSI.
 */
async function getConnection(connectionId) {
    const command = new QueryCommand({
        TableName: WS_CONNECTIONS_TABLE,
        IndexName: 'ConnectionIdIndex',
        KeyConditionExpression: 'connectionId = :cid',
        ExpressionAttributeValues: { ':cid': connectionId },
        Limit: 1
    });
    const res = await docClient.send(command);
    return (res.Items && res.Items.length > 0) ? res.Items[0] : null;
}

/**
 * Finds user's active connection via V2 GSI.
 */
async function getActiveConnectionByUserId(userId) {
    const command = new QueryCommand({
        TableName: WS_CONNECTIONS_TABLE,
        // Using Primary Key since userId is HASH
        KeyConditionExpression: 'userId = :uid AND begins_with(connectionKey, :prefix)',
        FilterExpression: 'isActive = :active',
        ExpressionAttributeValues: {
            ':uid': userId,
            ':prefix': 'CONN#',
            ':active': 'true'
        },
        ScanIndexForward: false,
        Limit: 1
    });
    const res = await docClient.send(command);
    return (res.Items && res.Items.length > 0) ? res.Items[0] : null;
}

/**
 * Finds all active connections for a session using V2 GSI.
 */
async function getConnectionsBySessionId(sessionId) {
    const command = new QueryCommand({
        TableName: WS_CONNECTIONS_TABLE,
        IndexName: 'SessionConnectionIndex',
        KeyConditionExpression: 'sessionId = :sid',
        ExpressionAttributeValues: { ':sid': sessionId }
    });
    const res = await docClient.send(command);
    return res.Items || [];
}

module.exports = {
    getActiveConnectionByUserId,
    saveConnection,
    deactivateConnection,
    updateHeartbeat,
    associateSession,
    getConnection,
    getConnectionsBySessionId
};
