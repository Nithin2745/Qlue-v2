const admin = require('../../lib/firebase');
const AWS = require('aws-sdk');

const dynamodb = new AWS.DynamoDB.DocumentClient();
const USERS_TABLE = process.env.USERS_TABLE || 'qlue-users';
const RESUMES_TABLE = process.env.RESUMES_TABLE || 'qlue-resumes';

const deleteAccount = async (req, res) => {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'MISSING_TOKEN', message: 'Authorization header is missing or invalid' });
        }

        const token = authHeader.split('Bearer ')[1].trim();

        // 1. Verify token using Firebase Admin SDK (Aligns with your fully reverted architecture instead of Custom JWTs)
        let decodedToken;
        try {
            decodedToken = await admin.auth().verifyIdToken(token);
        } catch (err) {
            return res.status(401).json({ error: 'INVALID_TOKEN', message: 'Token verification failed' });
        }

        const firebaseUid = decodedToken.uid;

        // 2. Fetch user from DynamoDB using firebaseUid
        const getUserParams = {
            TableName: USERS_TABLE,
            IndexName: 'firebaseUid-index',
            KeyConditionExpression: 'firebaseUid = :uid',
            ExpressionAttributeValues: {
                ':uid': firebaseUid
            }
        };

        const result = await dynamodb.query(getUserParams).promise();
        const user = result.Items && result.Items.length > 0 ? result.Items[0] : null;

        if (!user) {
            return res.status(404).json({ error: 'USER_NOT_FOUND', message: 'User record not found in database' });
        }

        const userId = user.userId;

        // 3. Delete Firebase user using admin.auth().deleteUser
        try {
            await admin.auth().deleteUser(firebaseUid);
        } catch (firebaseErr) {
            console.warn("Firebase deletion failed. User might already be deleted or invalid.", firebaseErr);
        }

        // 4. Delete user from DynamoDB
        const deleteParams = {
            TableName: USERS_TABLE,
            Key: {
              userId: userId
            }
        };

        await dynamodb.delete(deleteParams).promise();

        // Optional Cleanup: Delete related Resumes
        try {
            const resumeParams = {
                TableName: RESUMES_TABLE,
                IndexName: 'userId-index',
                KeyConditionExpression: 'userId = :userId',
                ExpressionAttributeValues: { ':userId': userId },
            };
            const resumeResult = await dynamodb.query(resumeParams).promise();
            const resumes = resumeResult.Items || [];
            
            const deletePromises = resumes.map(r => {
                const keyName = r.resumeId ? 'resumeId' : 'id';
                return dynamodb.delete({ TableName: RESUMES_TABLE, Key: { [keyName]: r[keyName] } }).promise();
            });
            await Promise.all(deletePromises);
        } catch (err) {}

        // 5. Return success response
        return res.status(200).json({
            message: "Account deleted successfully"
        });

    } catch (error) {
        console.error('Delete Account Error:', error);
        return res.status(500).json({ error: 'DELETE_ACCOUNT_FAILED', details: error.message });
    }
};

module.exports = { deleteAccount };
