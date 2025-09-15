// backend/src/db/firestore.js
const admin = require('firebase-admin');

function initApp() {
  if (admin.apps.length) return;

  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (b64) {
    const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    // console.log('[Firestore] Service account:', {
    //   client_email: json.client_email,
    //   project_id: json.project_id
    // });
    admin.initializeApp({
      credential: admin.credential.cert(json),
      projectId: json.project_id, // fontos: explicit projectId
    });
    return;
  }

  // fallback: ha lokálisan GOOGLE_APPLICATION_CREDENTIALS-t használsz
  console.log('[Firestore] Service account: applicationDefault');
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
}

initApp();

const db = admin.firestore();
module.exports = { db, admin };
