const admin = require('../../lib/firebase');

const validateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        error: "Unauthorized", 
        message: "Missing or invalid Authorization header. Expected 'Bearer <token>'" 
      });
    }

    const token = authHeader.split('Bearer ')[1];

    const decodedToken = await admin.auth().verifyIdToken(token, true);
    req.user = decodedToken;

    return res.status(200).json({
      message: "Token is valid",
      user: {
        uid: decodedToken.uid,
        email: decodedToken.email,
      },
    });

  } catch (error) {
    console.error("Token Validation Error:", error);
    
    if (error.code === 'auth/id-token-expired') {
      return res.status(401).json({ error: "Unauthorized", message: "Token has expired" });
    }
    
    if (error.code === 'auth/id-token-revoked') {
      return res.status(401).json({ error: "Unauthorized", message: "Token has been revoked/logged out" });
    }
    
    return res.status(403).json({ 
      error: "Forbidden", 
      message: "Token is invalid" 
    });
  }
};

module.exports = { validateToken };
