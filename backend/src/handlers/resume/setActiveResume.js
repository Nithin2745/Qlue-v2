const { toggleActiveStatus } = require('../../models/resume');
const { setActiveResumeId } = require('../../models/user');
const { success, unauthorized, badRequest, internalError } = require('../../lib/response');

/**
 * AWS Lambda Handler: POST /resume/active
 */
exports.handler = async (event) => {
    try {
        const authorizer = event.requestContext?.authorizer;
        const userId = authorizer?.uid || authorizer?.principalId || authorizer?.claims?.sub;

        if (!userId) {
            return unauthorized('Missing user context');
        }

        const body = typeof event.body === 'string' ? JSON.parse(event.body || '{}') : (event.body || {});
        const { resumeId } = body;
        if (!resumeId) {
            return badRequest('resumeId is required');
        }

        // 1. Toggle active status across all user resumes (V2 optimized)
        await toggleActiveStatus(userId, resumeId);

        // 2. Update the User profile record (V2)
        await setActiveResumeId(userId, resumeId);

        return success({ message: 'Active resume updated successfully' });

    } catch (error) {
        console.error('Set Active Resume Error:', error);
        return internalError(error.message);
    }
};
