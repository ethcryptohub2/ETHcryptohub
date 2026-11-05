-- Apply once to MySQL installations that already have the users table.
-- Stores only a hashed email/IP key and the last request timestamp.
CREATE TABLE IF NOT EXISTS email_verification_requests (
    request_key CHAR(64) NOT NULL,
    requested_at BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (request_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
