const admin = require('../../lib/firebase');
const axios = require('axios');

const registerUser = async (req, res) => {
  try {
    const { email, password, displayName } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters long" });
    }

    // 1. Create the user in Firebase Auth tracking unverified status
    const userRecord = await admin.auth().createUser({
      email,
      password,
      displayName: displayName || undefined,
      emailVerified: false 
    });

    const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
    if (!FIREBASE_API_KEY) {
      console.warn("FIREBASE_API_KEY not found in env, email verification cannot be sent automatically.");
      return res.status(201).json({
        message: "User registered successfully, but verification email could not be sent (missing API config)",
        userId: userRecord.uid
      });
    }

    // 2. We use the Web REST API to securely login the user behind the scenes 
    // to get their idToken, which is required to trigger Firebase's native verification email
    const signInRes = await axios.post(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
        { email, password, returnSecureToken: true }
    );
    
    const idToken = signInRes.data.idToken;

    // 3. Trigger Firebase's native email sender
    await axios.post(
        `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${FIREBASE_API_KEY}`,
        { requestType: 'VERIFY_EMAIL', idToken: idToken }
    );

    return res.status(201).json({
      message: "User registered successfully! A verification link has been sent to your email address.",
      userId: userRecord.uid,
      verificationSent: true
    });

  } catch (error) {
    console.error("Firebase Registration Error:", error.response?.data || error.message);

    if (error.code === 'auth/email-already-exists') {
      return res.status(409).json({ error: "A user with this email already exists" });
    }

    return res.status(500).json({ 
      error: "Internal server error during registration",
      details: error.message
    });
  }
};

module.exports = { registerUser };
