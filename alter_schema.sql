-- Apply once after importing schema.sql. Back up the database before migration.
ALTER TABLE users
    ADD COLUMN role ENUM('user', 'admin') NOT NULL DEFAULT 'user',
    ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1,
    ADD COLUMN last_login TIMESTAMP NULL DEFAULT NULL;

CREATE TABLE IF NOT EXISTS admin_login_attempts (
    ip_hash CHAR(64) NOT NULL,
    attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
    window_started_at DATETIME NOT NULL,
    locked_until DATETIME NULL DEFAULT NULL,
    PRIMARY KEY (ip_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- This bootstrap hash is bcrypt but was generated from a discarded random secret.
-- It cannot be used to sign in. Set a private password hash before using the admin account:
-- php -r "echo password_hash('YOUR-UNIQUE-ADMIN-PASSWORD', PASSWORD_BCRYPT), PHP_EOL;"
-- Then run: UPDATE users SET password_hash = 'PASTE_HASH_HERE' WHERE email = 'admin@ethcryptohub.local';
-- Change the email to an address you control and verify it before production use.
INSERT INTO users (
    email, password_hash, full_name, country_code, role, is_active,
    is_email_verified, email_verification_token
)
SELECT
    'admin@ethcryptohub.local',
    '$2y$12$Z2U6oc0SYZ3ww39wrpKr7uk05PmCfiTfI7kKgG8QBU8z1EfbEbDg.',
    'ETHcryptohub Administrator',
    '+91',
    'admin',
    1,
    1,
    NULL
WHERE NOT EXISTS (
    SELECT 1 FROM users WHERE email = 'admin@ethcryptohub.local'
);
