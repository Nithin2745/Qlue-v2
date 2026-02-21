const axios = require('axios');
const admin = require('../../lib/firebase');

const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY; 

const loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    // Authenticate using the Firebase Identity Toolkit (Auth REST API)
    const response = await axios.post(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
      {
        email,
        password,
        returnSecureToken: true,
      }
    );

    const { idToken, refreshToken, expiresIn, localId } = response.data;

    // Retrieve the user from Firebase Admin to guarantee they clicked the email link
    const userRecord = await admin.auth().getUser(localId);

    if (!userRecord.emailVerified) {
       return res.status(403).json({
           error: "EMAIL_NOT_VERIFIED",
           message: "Please click the verification link sent to your email to activate your account before logging in."
       });
    }

    // 🏆 Login successful, user is fully verified
    return res.status(200).json({
      message: "Login successful",
      uid: localId,
      token: idToken,
      refreshToken: refreshToken,
    });
  } catch (error) {
    console.error("Login error:", error.response?.data || error.message);
    const errorMessage = error.response?.data?.error?.message || "Invalid credentials";
    
    return res.status(401).json({ 
      error: "Authentication failed", 
      details: errorMessage 
    });
  }
};

module.exports = { loginUser };
