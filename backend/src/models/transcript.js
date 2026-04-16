const { docClient } = require('../lib/dynamodb');
const { PutCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");
const { randomUUID } = require('crypto');
const { CloudWatchClient, PutMetricDataCommand } = require("@aws-sdk/client-cloudwatch");

const cloudwatch = new CloudWatchClient({});

const TRANSCRIPTS_TABLE = process.env.TRANSCRIPTS_TABLE || 'qlue-transcripts';
const TRANSCRIPTS_TABLE_V2 = process.env.TRANSCRIPTS_TABLE_V2;

const SPEAKERS = {
    USER: 'USER',
    AI: 'AI'
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
 * Saves a transcript entry to DynamoDB.
 */
async function saveTranscript(sessionId, turnIndex, speaker, text) {
    const transcript = {
        transcriptId: randomUUID(),
        sessionId,
        turnIndex,
        speaker,
        text,
        timestamp: new Date().toISOString()
    };

    const oldWrite = () => docClient.send(new PutCommand({
        TableName: TRANSCRIPTS_TABLE,
        Item: transcript
    }));

    const newWrite = async () => {
        if (!TRANSCRIPTS_TABLE_V2) return;
        const transcriptV2 = {
            sessionId,
            turnKey: `TURN#${String(turnIndex).padStart(4, '0')}`,
            transcriptId: transcript.transcriptId,
            turnIndex,
            speaker,
            text,
            timestamp: transcript.timestamp
        };
        await docClient.send(new PutCommand({
            TableName: TRANSCRIPTS_TABLE_V2,
            Item: transcriptV2
        }));
    };

    await dualWrite(oldWrite, newWrite, 'TranscriptsTableV2', { sessionId, turnIndex });
    return transcript;
}

/**
 * Retrieves the full transcript for a session, ordered by turnIndex.
 */
async function getTranscriptBySession(sessionId) {
    const command = new QueryCommand({
        TableName: TRANSCRIPTS_TABLE,
        IndexName: 'GSI_SessionIdTurnIndex',
        KeyConditionExpression: 'sessionId = :sid',
        ExpressionAttributeValues: {
            ':sid': sessionId
        },
        ScanIndexForward: true // Ascending by turnIndex
    });

    const result = await docClient.send(command);
    return result.Items || [];
}

module.exports = {
    SPEAKERS,
    saveTranscript,
    getTranscriptBySession
};
