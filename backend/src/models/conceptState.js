const { docClient } = require('../lib/dynamodb');
const { UpdateCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { CloudWatchClient, PutMetricDataCommand } = require("@aws-sdk/client-cloudwatch");
const { getSession } = require('./session');

const cloudwatch = new CloudWatchClient({});

const CONCEPTS_TABLE = process.env.CONCEPTS_TABLE_NAME || 'Concepts';
const SESSIONS_TABLE_V2 = process.env.SESSIONS_TABLE_V2;

const CONCEPT_STATES = {
    UNADDRESSED: 'UNADDRESSED',
    TUTORED: 'TUTORED',
    MASTERED: 'MASTERED'
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
 * Updates or creates a concept state in DynamoDB.
 */
async function updateConceptState(sessionId, conceptId, state, attemptIncrement = 1) {
    const command = new UpdateCommand({
        TableName: CONCEPTS_TABLE,
        Key: { sessionId, conceptId },
        UpdateExpression: 'SET #st = :state ADD attempts :inc',
        ExpressionAttributeNames: {
            '#st': 'state'
        },
        ExpressionAttributeValues: {
            ':state': state,
            ':inc': attemptIncrement
        },
        ReturnValues: 'ALL_NEW'
    });
    
    let oldWriteResponse;
    const oldWrite = async () => {
        oldWriteResponse = await docClient.send(command);
    };

    const newWrite = async () => {
        if (!SESSIONS_TABLE_V2) return;
        const session = await getSession(sessionId);
        if (!session) return;
        
        let attempts = (oldWriteResponse?.Attributes?.attempts) || attemptIncrement;
        
        await docClient.send(new UpdateCommand({
            TableName: SESSIONS_TABLE_V2,
            Key: { userId: session.userId, sessionKey: `SESSION#${sessionId}` },
            UpdateExpression: 'SET conceptStates = if_not_exists(conceptStates, :emptyMap), conceptStates.#cid = :conceptObj',
            ExpressionAttributeNames: { '#cid': conceptId },
            ExpressionAttributeValues: { 
                ':emptyMap': {}, 
                ':conceptObj': { state: state, attempts: attempts } 
            }
        }));
    };

    await dualWrite(oldWrite, newWrite, 'SessionsTableV2', { sessionId, conceptId });
    return oldWriteResponse?.Attributes;
}

/**
 * Retrieves all concepts for a given session.
 */
async function getConceptsBySession(sessionId) {
    const command = new QueryCommand({
        TableName: CONCEPTS_TABLE,
        KeyConditionExpression: 'sessionId = :sessionId',
        ExpressionAttributeValues: {
            ':sessionId': sessionId
        }
    });
    
    const res = await docClient.send(command);
    return res.Items || [];
}

/**
 * Selects the next appropriate concept for the Adaptive Tutor.
 * Prioritizes UNADDRESSED, then falls back to TUTORED if attempts < 3.
 */
async function selectNextConcept(sessionId) {
    const concepts = await getConceptsBySession(sessionId);
    if (!concepts || concepts.length === 0) return null;

    const unaddressed = concepts.find(c => c.state === CONCEPT_STATES.UNADDRESSED);
    if (unaddressed) return unaddressed;

    // Fall back to Tutored if we haven't exhausted attempts (max 3 tries)
    const tutored = concepts.find(c => c.state === CONCEPT_STATES.TUTORED && (c.attempts || 0) < 3);
    if (tutored) return tutored;

    // If everything is MASTERED or exhausted attempts
    return null;
}

/**
 * Validates external comprehension via Bedrock evaluation (Stubbed for Nithin's prompt integration)
 */
async function evaluateComprehension(sessionId, textTranscript, referenceMaterial) {
    const { invokeModel } = require('../lib/bedrock');
    
    // Nithin implements the exact prompt structure in lib/bedrock later.
    // Here we orchestrate the interaction logic.
    const promptParams = {
        prompt: `Evaluate if the following user explanation matches the reference material.\nReference: ${referenceMaterial}\nExplanation: ${textTranscript}`,
        task: 'COMPREHENSION_CHECK'
    };

    try {
        const result = await invokeModel(undefined, promptParams);
        return {
            status: parseInt(result.score || 0) >= 70 ? 'COMPREHENDED' : 'NOT_YET_COMPREHENDED',
            confidence: result.confidence || 0.8
        };
    } catch (err) {
        console.error('evaluateComprehension failed:', err);
        return { status: 'NOT_YET_COMPREHENDED', confidence: 0 };
    }
}

module.exports = {
    CONCEPT_STATES,
    updateConceptState,
    getConceptsBySession,
    selectNextConcept,
    evaluateComprehension
};
