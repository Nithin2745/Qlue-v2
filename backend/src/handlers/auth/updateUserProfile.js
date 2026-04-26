const { updateUserProfile } = require('../../models/user');

/**
 * AWS Lambda Handler: PUT /auth/profile
 */
exports.handler = async (event) => {
    try {
        const authorizer = event.requestContext?.authorizer;
        const userId = authorizer?.uid || authorizer?.principalId || authorizer?.claims?.sub;

        if (!userId) {
            return {
                statusCode: 401,
                body: JSON.stringify({ error: 'UNAUTHORIZED', message: 'User context missing' })
            };
        }

        const body = JSON.parse(event.body || '{}');
        const { displayName, photoUrl, profession, skills, voiceId } = body;

        const updates = {};
        if (displayName !== undefined) updates.displayName = displayName;
        if (photoUrl !== undefined) updates.photoUrl = photoUrl;
        if (profession !== undefined) updates.profession = profession;
        if (skills !== undefined) updates.skills = skills;
        if (voiceId !== undefined) updates.voiceId = voiceId;

        if (Object.keys(updates).length === 0) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'NO_UPDATE_FIELDS', message: 'Provide fields to update' })
            };
        }

        if (displayName && displayName.length > 50) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'INVALID_INPUT', message: 'displayName too long' })
            };
        }

        const updatedUser = await updateUserProfile(userId, updates);

        return {
            statusCode: 200,
            body: JSON.stringify({
                message: 'Profile updated successfully',
                user: updatedUser
            })
        };

    } catch (error) {
        console.error('Update Profile Error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'UPDATE_PROFILE_FAILED', details: error.message })
        };
    }
};
