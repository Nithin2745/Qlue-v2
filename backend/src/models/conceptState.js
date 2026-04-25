const { docClient } = require('../lib/dynamodb');
const { UpdateCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');

const SESSIONS_TABLE = process.env.SESSIONS_TABLE;

const CONCEPT_STATES = {
    UNADDRESSED: 'UNADDRESSED',
    TUTORED: 'TUTORED',
    MASTERED: 'MASTERED'
};

/**
 * Updates or creates a concept state in V2 (inlined in Session).
 */
async function updateConceptState(userId, sessionKey, conceptId, state, attemptIncrement = 1) {
    const res = await docClient.send(new UpdateCommand({
        TableName: SESSIONS_TABLE,
        Key: { PK: `USER#${userId}`, SK: sessionKey },
        UpdateExpression: 'SET conceptStates = if_not_exists(conceptStates, :emptyMap), conceptStates.#cid = :conceptObj',
        ExpressionAttributeNames: { '#cid': conceptId },
        ExpressionAttributeValues: { 
            ':emptyMap': {}, 
            ':conceptObj': { state: state, attempts: attemptIncrement } // Note: Adding increment logic if needed
        },
        ReturnValues: 'ALL_NEW'
    }));
    
    return res.Attributes?.conceptStates?.[conceptId];
}

/**
 * Retrieves all concepts for a given session from V2 (inlined).
 */
async function getConceptsBySession(userId, sessionKey) {
    const command = new GetCommand({
        TableName: SESSIONS_TABLE,
        Key: { PK: `USER#${userId}`, SK: sessionKey }
    });
    const res = await docClient.send(command);
    const conceptStates = res.Item?.conceptStates || {};
    
    // Transform to array format for compatibility
    return Object.entries(conceptStates).map(([conceptId, data]) => ({
        conceptId,
        ...data
    }));
}

/**
 * Selects the next appropriate concept for the Adaptive Tutor in V2.
 */
async function selectNextConcept(userId, sessionKey) {
    const concepts = await getConceptsBySession(userId, sessionKey);
    if (!concepts || concepts.length === 0) return null;

    const unaddressed = concepts.find(c => c.state === CONCEPT_STATES.UNADDRESSED);
    if (unaddressed) return unaddressed;

    const tutored = concepts.find(c => c.state === CONCEPT_STATES.TUTORED && (c.attempts || 0) < 3);
    if (tutored) return tutored;

    return null;
}

/**
 * Validates external comprehension via Bedrock evaluation.
 */
async function evaluateComprehension(textTranscript, referenceMaterial) {
    const { invokeModel } = require('../lib/bedrock');
    
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
