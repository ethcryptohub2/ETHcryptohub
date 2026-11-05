<?php
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

require_once __DIR__ . '/config.php';

$recipient = $argv[1] ?? '';
if (!is_string($recipient) || filter_var($recipient, FILTER_VALIDATE_EMAIL) === false) {
    fwrite(STDERR, "Usage: php email-delivery-check.php recipient@example.com\n");
    exit(2);
}

$configurationErrors = emailDeliveryConfigurationErrors();
if ($configurationErrors !== []) {
    fwrite(STDERR, "Email delivery is not configured:\n");
    foreach ($configurationErrors as $configurationError) {
        fwrite(STDERR, ' - ' . $configurationError . "\n");
    }
    exit(2);
}

$sent = sendEmailViaResend(
    $recipient,
    'ETHcryptohub email delivery test',
    "This is a test of ETHcryptohub email delivery.\nNo account changes were made.\n",
    '<p>This is a test of ETHcryptohub email delivery.</p><p>No account changes were made.</p>'
);
if (!$sent) {
    fwrite(STDERR, "Resend did not accept the email. Check the PHP error log and Resend delivery dashboard.\n");
    exit(1);
}

fwrite(STDOUT, "Resend accepted the test email. Check the recipient inbox, spam folder, and Resend delivery dashboard.\n");
