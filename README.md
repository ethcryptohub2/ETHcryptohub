# ETHcryptohub

ETHcryptohub is a PHP account, identity, and trading dashboard with an integrated SmartExit paper-trading terminal.

- PHP 8.4 with PDO for account data and protected admin tools.
- Supabase PostgreSQL for application accounts and SmartExit paper-trade data.
- SmartExit Node.js API and Vite frontend; order placement is disabled.
- Railway runs the PHP and Node services. Vercel provides the public same-origin proxy.

## Local development

Run the PHP application using the repository's existing SQLite development fallback, and run SmartExit using the instructions in [smartexit/README.md](./smartexit/README.md). Local databases, `.env` files, API keys, and encryption keys are excluded from Git.

## Deployment

Follow [DEPLOYMENT.md](./DEPLOYMENT.md) to create the Supabase project, run migrations, configure Railway services, and connect Vercel. Never commit production credentials or paste them into issues, chat, or source files.

The Supabase migrations are in [supabase/migrations/](./supabase/migrations/). Apply them in numerical order using the Supabase SQL editor or a trusted migration runner.
