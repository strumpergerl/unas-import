// api/[[...all]].js
console.log('[[...all]] handler loaded');

// Minimal Vercel function for debug
module.exports = (req, res) => {
  res.json({ ok: true, path: req.url, method: req.method });
};
