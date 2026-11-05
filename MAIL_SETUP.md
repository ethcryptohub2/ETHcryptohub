# Email verification setup

ETHcryptohub sends six-digit email verification codes through Resend. Configure these server-side environment variables in `.env.local` for local development or in Vercel project settings for production:

- `RESEND_API_KEY`: private Resend API key.
- `MAIL_FROM`: address on a domain verified with Resend.

After configuration, restart the local Next.js server or redeploy the Vercel project. Register a new account or use `/resend-verification` to request another code. Check Resend's delivery events and the recipient's spam folder if a message does not arrive. A successful Resend API response confirms provider handoff, not inbox placement.

Never add the API key to client-side code or a `NEXT_PUBLIC_*` variable. Do not send it through chat or commit it to source control.
