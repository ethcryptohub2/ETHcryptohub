import nodemailer from 'nodemailer';

export class EmailDeliveryError extends Error {
  constructor(message: string) { super(message); this.name = 'EmailDeliveryError'; }
}

type MailTransportFailure = Error & {
  code?: string;
  command?: string;
  responseCode?: number;
};

export async function sendVerificationCode(email: string, code: string) {
  const gmailUser = process.env.GMAIL_USER?.trim();
  const gmailAppPassword = process.env.GMAIL_APP_PASSWORD?.replace(/\s/g, '');
  if (gmailUser || gmailAppPassword) {
    if (!gmailUser || !gmailAppPassword) {
      throw new EmailDeliveryError('Gmail delivery requires both GMAIL_USER and GMAIL_APP_PASSWORD.');
    }

    try {
      const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: { user: gmailUser, pass: gmailAppPassword },
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 10_000,
      });
      await transporter.sendMail({
        from: { name: 'ETHcryptohub', address: gmailUser },
        to: email,
        subject: 'Your ETHcryptohub verification code',
        text: `Your verification code is ${code}. It expires in 10 minutes.`,
      });
      return;
    } catch (error) {
      const failure = error instanceof Error ? error as MailTransportFailure : null;
      console.error('Gmail verification email delivery failed:', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
        code: failure?.code,
        command: failure?.command,
        responseCode: failure?.responseCode,
      });
      throw new EmailDeliveryError('Gmail SMTP could not send the verification email. Check the Gmail address and App Password.');
    }
  }

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM;
  if (!apiKey || !from) {
    throw new EmailDeliveryError(
      'Email delivery is not configured. Set GMAIL_USER and GMAIL_APP_PASSWORD, or RESEND_API_KEY and MAIL_FROM.',
    );
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [email],
        subject: 'Your ETHcryptohub verification code',
        text: `Your verification code is ${code}. It expires in 10 minutes.`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new EmailDeliveryError(`Email delivery provider returned status ${response.status}.`);
  } catch (error) {
    if (error instanceof EmailDeliveryError) throw error;
    throw new EmailDeliveryError('Email delivery provider could not be reached.');
  }
}
