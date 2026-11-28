SELECT
    EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'signal_events_event_type_check'
    ) AS verified;
