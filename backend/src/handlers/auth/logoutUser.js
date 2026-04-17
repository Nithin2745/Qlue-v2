const admin = require('../../lib/firebase');
const jwt = require('jsonwebtoken');

const logoutUser = async (req, res) => {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'MISSING_ACCESS_TOKEN' });
        }

        const idToken = authHeader.split('Bearer ')[1].trim(); 
        const decodedToken = jwt.decode(idToken);
        console.log("Logout Debug - Decoded Token payload:", decodedToken);
        
        if (!decodedToken || (!decodedToken.uid && !decodedToken.user_id && !decodedToken.sub)) {
             return res.status(401).json({ error: 'INVALID_ACCESS_TOKEN_FORMAT', receivedTokenStart: idToken.substring(0, 10) });
        }

        // Firebase stores the unique ID primarily in user_id or sub
        const uid = decodedToken.user_id || decodedToken.uid || decodedToken.sub;

        // Revoke all Firebase refresh tokens associated with this user
        await admin.auth().revokeRefreshTokens(uid);

        return res.status(200).json({
            message: 'Logout successful',
        });
    } catch (error) {
        console.error('Logout Error:', error);
        return res.status(500).json({ error: 'LOGOUT_FAILED', details: error.message });
    }
};

module.exports = { logoutUser };
