import nodemailer from 'nodemailer';

export class EmailDeliveryError extends Error {
  constructor(message: string) { super(message); this.name = 'EmailDeliveryError'; }
}

type MailTransportFailure = Error & {
  code?: string;
  command?: string;
  responseCode?: number;
};

export function verificationLink(email: string, code: string) {
  const configuredOrigin = process.env.APP_URL?.trim();
  const productionHost = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  const deploymentHost = process.env.VERCEL_URL?.trim();
  const previewHost = process.env.VERCEL_BRANCH_URL?.trim() || deploymentHost;
  const vercelEnvironment = process.env.VERCEL_ENV;
  if (vercelEnvironment === 'preview' && !configuredOrigin && !previewHost) {
    throw new EmailDeliveryError('APP_URL, VERCEL_BRANCH_URL, or VERCEL_URL must identify the Preview origin.');
  }
  const vercelHost = vercelEnvironment === 'preview' ? previewHost : productionHost || deploymentHost;
  const origin = configuredOrigin || (vercelHost ? `https://${vercelHost}` : 'http://localhost:3000');
  let url: URL;
  try {
    url = new URL('/verify-email', origin);
  } catch {
    throw new EmailDeliveryError('APP_URL must be a valid HTTP or HTTPS origin.');
  }
  if (vercelEnvironment === 'preview' && productionHost) {
    const productionOrigin = productionHost.startsWith('http') ? productionHost : `https://${productionHost}`;
    if (url.hostname.toLowerCase() === new URL(productionOrigin).hostname.toLowerCase()) {
      throw new EmailDeliveryError('Preview verification links must not use the Production host.');
    }
  }
  const isDeployed = vercelEnvironment === 'preview' ||
    vercelEnvironment === 'production' ||
    process.env.NODE_ENV === 'production';
  if (url.protocol !== 'https:' && !(url.hostname === 'localhost' && !isDeployed)) {
    throw new EmailDeliveryError('APP_URL must use HTTPS in deployed environments.');
  }
  url.searchParams.set('email', email);
  url.searchParams.set('code', code);
  return url.toString();
}

async function sendEmail(email: string, subject: string, text: string, html: string) {
  const gmailUser = process.env.GMAIL_USER?.trim();
  const gmailAppPassword = process.env.GMAIL_APP_PASSWORD?.replace(/\s/g, '');
  if (gmailUser || gmailAppPassword) {
    if (!gmailUser || !gmailAppPassword) {
      throw new EmailDeliveryError('Gmail delivery requires both GMAIL_USER and GMAIL_APP_PASSWORD.');
    }

    const portValue = process.env.GMAIL_SMTP_PORT?.trim() || '465';
    if (portValue !== '465' && portValue !== '587') {
      throw new EmailDeliveryError('GMAIL_SMTP_PORT must be 465 (SSL) or 587 (STARTTLS).');
    }
    const port = Number(portValue);

    try {
      const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port,
        secure: port === 465,
        requireTLS: port === 587,
        auth: { user: gmailUser, pass: gmailAppPassword },
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 10_000,
      });
      await transporter.sendMail({
        from: { name: 'ETHcryptohub', address: gmailUser },
        to: email,
        subject,
        text,
        html,
      });
      return;
    } catch (error) {
      const failure = error instanceof Error ? error as MailTransportFailure : null;
      console.error('Gmail authentication email delivery failed:', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
        code: failure?.code,
        command: failure?.command,
        responseCode: failure?.responseCode,
      });
      if (failure?.code === 'EAUTH') {
        throw new EmailDeliveryError(
          'Gmail rejected SMTP authentication. Confirm GMAIL_USER matches the account that created the Google App Password; changing port 465/587 will not fix invalid credentials.',
        );
      }
      throw new EmailDeliveryError(
        `Gmail SMTP could not send the verification email${failure?.code ? ` (${failure.code})` : ''}. Check the sender settings and selected SMTP port.`,
      );
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
        subject,
        text,
        html,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new EmailDeliveryError(`Email delivery provider returned status ${response.status}.`);
  } catch (error) {
    if (error instanceof EmailDeliveryError) throw error;
    throw new EmailDeliveryError('Email delivery provider could not be reached.');
  }
}

export async function sendVerificationCode(email: string, code: string) {
  const verifyUrl = verificationLink(email, code);
  const text = `Your verification code is ${code}. It expires in 10 minutes.\n\nActivate your account: ${verifyUrl}`;
  const htmlLink = verifyUrl.replace(/&/g, '&amp;');
  const html = `<p>Your verification code is <strong>${code}</strong>. It expires in 10 minutes.</p><p><a href="${htmlLink}">Activate your ETHcryptohub account</a></p>`;
  await sendEmail(email, 'Your ETHcryptohub verification code', text, html);
}

export async function sendPasswordResetCode(email: string, code: string) {
  const text = `Your password reset code is ${code}. It expires in 10 minutes. If you did not request this, you can ignore this email.`;
  const html = `<p>Your password reset code is <strong>${code}</strong>. It expires in 10 minutes.</p><p>If you did not request this, you can ignore this email.</p>`;
  await sendEmail(email, 'Your ETHcryptohub password reset code', text, html);
}
