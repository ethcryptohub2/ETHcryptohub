-- Apply once to MySQL installations that already have the users table.
-- Verification codes are stored as password hashes and expire after ten minutes.
CREATE TABLE IF NOT EXISTS email_verification_codes (
    user_id INT NOT NULL,
    code_hash VARCHAR(255) NOT NULL,
    expires_at BIGINT UNSIGNED NOT NULL,
    attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
    locked_until BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id),
    CONSTRAINT email_verification_codes_user_fk
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
