-- Expand signal_events_event_type_check to allow execution and trade protection notification events
ALTER TABLE public.signal_events
    DROP CONSTRAINT IF EXISTS signal_events_event_type_check;

ALTER TABLE public.signal_events
    ADD CONSTRAINT signal_events_event_type_check
    CHECK (event_type IN (
        'NEW_SIGNAL', 'SIGNAL_GENERATED', 'SIGNAL_UPDATED', 'ENTRY_OPEN',
        'ENTRY_REACHED', 'ENTRY_MARKED_AS_ENTERED', 'ENTRY_MISSED', 'PARTIAL_TARGET_HIT',
        'TP1_HIT', 'TP2_HIT', 'TP3_HIT', 'STOP_LOSS_HIT', 'SIGNAL_EXPIRED',
        'SIGNAL_INVALIDATED', 'ENTRY_INVALIDATED', 'TRADE_CLOSED',
        'AMBIGUOUS_PRICE_PATH',
        'CONFIRMED_DEMO_EXECUTION', 'TRADE_FILLED', 'EXCHANGE_FAILURE',
        'EXECUTION_REJECTED', 'PROTECTION_FAILED'
    ));
