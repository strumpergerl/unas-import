require('./bootstrapEnv');
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: process.env.EMAIL_PORT,
  secure: true,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

function parseRecipients(raw) {
	if (!raw) return [];
	return String(raw)
		.split(/[,;]+/)
		.map((part) => part.trim())
		.filter(Boolean);
}

function stripHtml(html) {
	return String(html)
		.replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, '')
		.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
		.replace(/<\/(p|div|li|h[1-6]|br)>/gi, '\n')
		.replace(/<[^>]+>/g, '')
		.replace(/\r?\n\s*\r?\n/g, '\n')
		.trim();
}

async function sendNotification(subject, content) {
	const recipients = parseRecipients(process.env.EMAIL_TO);
	if (!recipients.length) {
		throw new Error('EMAIL_TO is not configured with at least one recipient.');
	}

	let text = '';
	let html = '';

	if (content && typeof content === 'object') {
		text = content.text || '';
		html = content.html || '';
	} else if (typeof content === 'string') {
		html = content;
	}

	if (!text && html) {
		text = stripHtml(html);
	}

	await transporter.sendMail({
		from: process.env.EMAIL_FROM,
		to: recipients,
		subject,
		text: text || undefined,
		html: html || undefined,
	});
}

module.exports = { sendNotification };
