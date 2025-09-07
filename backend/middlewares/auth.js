// backend/middlewares/auth.js
const { admin } = require('../src/db/firestore');

async function requireFirebaseUser(req, res, next) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer (.+)$/);
  if (!m) return res.status(401).json({ error: 'Hiányzó Authorization Bearer token' });
  try {
    const decoded = await admin.auth().verifyIdToken(m[1]);
    req.user = decoded; // uid, email, stb.
    return next();
  } catch (e) {
    return res.status(401).json({ error: 'Érvénytelen vagy lejárt token' });
  }
}

// Scheduler vagy felhasználó: ha van X-CRON-SECRET és egyezik, engedjük; különben user auth.
function allowCronOrUser(requireUser) {
  return (req, res, next) => {
    const cronSecret = req.get('X-CRON-SECRET');
    if (cronSecret && cronSecret === process.env.CRON_SECRET) {
      req.isCron = true;
      return next();
    }
    return requireUser(req, res, next);
  };
}

module.exports = { requireFirebaseUser, allowCronOrUser };
