export class EmailDeliveryError extends Error {
  constructor(message: string) { super(message); this.name = 'EmailDeliveryError'; }
}

export async function sendVerificationCode(email: string, code: string) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM;
  if (!apiKey || !from) throw new EmailDeliveryError('Email delivery is not configured. Set RESEND_API_KEY and MAIL_FROM.');

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
