# Email verification setup

ETHcryptohub sends a six-digit activation code after signup. Configure one email provider using server-side environment variables in `.env.local` for local development or in Vercel project settings for production.

- `APP_URL`: optional public app origin used for activation links, such as `https://cryptohub.vercel.app`. Vercel's production host is used automatically if this is unset.

For Gmail SMTP:

- `GMAIL_USER`: the Gmail address used as the sender.
- `GMAIL_APP_PASSWORD`: a Google App Password for that account (Google 2-Step Verification must be enabled).
- `GMAIL_SMTP_PORT`: optional; `465` uses SSL and `587` uses STARTTLS. Defaults to `465`. A Gmail authentication error means the account or App Password is wrong; changing ports will not repair credentials.

Alternatively, for Resend:

- `RESEND_API_KEY`: private Resend API key.
- `MAIL_FROM`: sender address on a domain verified with Resend.

After configuration, restart the local Next.js server or redeploy the Vercel project. Register a new account or use `/resend-verification` to request another code. Check Resend's delivery events or Gmail's sent mail, and the recipient's spam folder, if a message does not arrive. A successful provider response confirms handoff, not inbox placement.

After changing a Vercel environment variable, redeploy the project so the new deployment uses the updated mail credentials.

Never add the API key to client-side code or a `NEXT_PUBLIC_*` variable. Do not send it through chat or commit it to source control.
