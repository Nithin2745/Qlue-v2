const { docClient } = require('../lib/dynamodb');
const { PutCommand, UpdateCommand, GetCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");

const USERS_TABLE = process.env.USERS_TABLE_V2 || process.env.USERS_TABLE || 'qlue-core-v2';
const USER_PROFILE_SK = 'PROFILE';

function getUserPk(userId) {
    return `USER#${userId}`;
}

/**
 * Creates or updates a user profile record in V2.
 */
async function saveUser(user) {
    const now = new Date().toISOString();
    const item = {
        ...user,
        PK: getUserPk(user.userId),
        SK: USER_PROFILE_SK,
        updatedAt: now,
        profileKey: USER_PROFILE_SK
    };
    if (!item.createdAt) item.createdAt = now;
    
    // Ensure authProviderKey exists if provider is present
    if (item.provider && !item.authProviderKey) {
        item.authProviderKey = `PROVIDER#${item.provider.toUpperCase()}`;
    }

    await docClient.send(new PutCommand({
        TableName: USERS_TABLE,
        Item: item
    }));
    
    return { success: true };
}

/**
 * Retrieves a user by their ID from V2.
 */
async function getUserById(userId) {
    const command = new GetCommand({
        TableName: USERS_TABLE,
        Key: { PK: getUserPk(userId), SK: USER_PROFILE_SK }
    });
    const res = await docClient.send(command);
    return res.Item || null;
}

/**
 * Updates a user's active resume reference in V2.
 */
async function setActiveResumeId(userId, resumeId) {
    const now = new Date().toISOString();
    
    const res = await docClient.send(new UpdateCommand({
        TableName: USERS_TABLE,
        Key: { PK: getUserPk(userId), SK: USER_PROFILE_SK },
        UpdateExpression: 'SET activeResumeId = :rid, updatedAt = :ua',
        ExpressionAttributeValues: { ':rid': resumeId, ':ua': now },
        ReturnValues: 'ALL_NEW'
    }));

    return res.Attributes;
}

/**
 * Retrieves a user by their email using V2 GSI.
 */
async function getUserByEmail(email) {
    const command = new QueryCommand({
        TableName: USERS_TABLE,
        IndexName: 'EmailIndex',
        KeyConditionExpression: 'email = :e',
        ExpressionAttributeValues: { ':e': email }
    });
    const res = await docClient.send(command);
    return (res.Items && res.Items.length > 0) ? res.Items[0] : null;
}

/**
 * Updates a user profile with V2 support.
 */
async function updateUserProfile(userId, updates) {
    const now = new Date().toISOString();
    let updateExpression = 'SET updatedAt = :ua';
    const expressionAttributeValues = { ':ua': now };
    
    Object.keys(updates).forEach(key => {
        updateExpression += `, ${key} = :${key}`;
        expressionAttributeValues[`:${key}`] = updates[key];
    });

    const res = await docClient.send(new UpdateCommand({
        TableName: USERS_TABLE,
        Key: { PK: getUserPk(userId), SK: USER_PROFILE_SK },
        UpdateExpression: updateExpression,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: 'ALL_NEW'
    }));

    return res.Attributes;
}

module.exports = {
    saveUser,
    getUserById,
    getUserByEmail,
    setActiveResumeId,
    updateUserProfile
};
