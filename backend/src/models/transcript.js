const { docClient } = require('../lib/dynamodb');
const { PutCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");
const { randomUUID } = require('crypto');

const TRANSCRIPTS_TABLE = process.env.TRANSCRIPTS_TABLE;

const SPEAKERS = {
    USER: 'USER',
    AI: 'AI'
};

/**
 * Saves a transcript entry to V2 DynamoDB with rich metadata support.
 */
async function saveTranscript(sessionId, turnIndex, speaker, text, metadata = {}) {
    const timestamp = new Date().toISOString();
    const transcript = {
        sessionId,
        turnKey: `TURN#${String(turnIndex).padStart(4, '0')}`,
        transcriptId: randomUUID(),
        turnIndex,
        speaker,
        text,
        timestamp,
        createdAt: timestamp,
        ...metadata
    };

    // Populate GSI keys if module and concept are present
    if (transcript.module && transcript.concept) {
        transcript.moduleConcept = `${transcript.module}#${transcript.concept}`;
        transcript.conceptKey = `${transcript.difficulty || 'MEDIUM'}#${timestamp}`;
    }

    await docClient.send(new PutCommand({
        TableName: TRANSCRIPTS_TABLE,
        Item: transcript
    }));

    return transcript;
}

/**
 * Retrieves the full transcript for a session from V2, ordered by turnKey.
 */
async function getTranscriptBySession(sessionId) {
    const command = new QueryCommand({
        TableName: TRANSCRIPTS_TABLE,
        KeyConditionExpression: 'sessionId = :sid AND begins_with(turnKey, :prefix)',
        ExpressionAttributeValues: { ':sid': sessionId, ':prefix': 'TURN#' },
        ScanIndexForward: true
    });
    const res = await docClient.send(command);
    return res.Items || [];
}

module.exports = {
    SPEAKERS,
    saveTranscript,
    getTranscriptBySession
};
