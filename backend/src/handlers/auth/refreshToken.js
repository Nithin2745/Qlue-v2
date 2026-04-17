const axios = require('axios');

const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;

const refreshToken = async (req, res) => {
  try {
    const { refreshToken: incomingToken } = req.body;

    if (!incomingToken) {
      return res.status(400).json({ error: 'MISSING_REFRESH_TOKEN' });
    }

    // Call Firebase Secure Token API to refresh the Firebase token
    const response = await axios.post(
      `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`,
      {
        grant_type: 'refresh_token',
        refresh_token: incomingToken,
      }
    );

    return res.status(200).json({
      token: response.data.id_token,
      refreshToken: response.data.refresh_token,
      expiresIn: response.data.expires_in,
    });
  } catch (error) {
    console.error('Refresh Token Error:', error.response?.data || error.message);
    
    // Firebase returns a specific error if the refresh token is expired or revoked
    if (error.response?.data?.error?.message === 'TOKEN_EXPIRED') {
        return res.status(401).json({ error: 'REFRESH_TOKEN_EXPIRED' });
    }

    return res.status(401).json({ error: 'INVALID_REFRESH_TOKEN' });
  }
};

module.exports = { refreshToken };
