const nodemailer = require('nodemailer');
require('dotenv').config();

const transporter = nodemailer.createTransport({
//   host: process.env.SMTP_HOST,
//   port: process.env.SMTP_PORT,
//   auth: {
//     user: process.env.SMTP_USER,
//     pass: process.env.SMTP_PASS
//   }
  service: "gmail",
  auth: {
    type: "OAuth2",
    user: "pepitapocok@gmail.com",
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
  },
});

async function sendNotification(subject, text) {
  await transporter.sendMail({
    from: process.env.EMAIL_FROM,
    to: process.env.EMAIL_TO,
    subject,
    text
  });
}

module.exports = { sendNotification };