-- REVIEW ONLY. No login, password, memberships, or remote installation.
-- Apply after staging-scanner-pilot.sql in the same approved Staging transaction.
CREATE ROLE smartexit_scanner_pilot NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO smartexit_scanner_pilot;
GRANT SELECT (singleton, stopped) ON public.scanner_pilot_control TO smartexit_scanner_pilot;
CREATE POLICY scanner_pilot_control_read ON public.scanner_pilot_control
    FOR SELECT TO smartexit_scanner_pilot USING (singleton);

GRANT SELECT ON public.scanner_coin_configs, public.notification_system_settings,
    public.high_risk_scalping_settings TO smartexit_scanner_pilot;
CREATE POLICY scanner_pilot_coins_read ON public.scanner_coin_configs
    FOR SELECT TO smartexit_scanner_pilot USING (
        exchange = 'BINANCE' AND quote_asset = 'USDT' AND contract_type = 'PERPETUAL'
        AND trading_status = 'TRADING' AND is_enabled
    );
CREATE POLICY scanner_pilot_standard_settings_read ON public.notification_system_settings
    FOR SELECT TO smartexit_scanner_pilot USING (singleton);
CREATE POLICY scanner_pilot_high_risk_settings_read ON public.high_risk_scalping_settings
    FOR SELECT TO smartexit_scanner_pilot USING (singleton);

GRANT SELECT, INSERT (slot_at, approved_sha, symbols),
    UPDATE (state, finished_at, failure_code, report)
    ON public.scanner_pilot_runs TO smartexit_scanner_pilot;
CREATE POLICY scanner_pilot_runs_read ON public.scanner_pilot_runs
    FOR SELECT TO smartexit_scanner_pilot USING (true);
CREATE POLICY scanner_pilot_runs_insert ON public.scanner_pilot_runs
    FOR INSERT TO smartexit_scanner_pilot WITH CHECK (state = 'RUNNING');
CREATE POLICY scanner_pilot_runs_finish ON public.scanner_pilot_runs
    FOR UPDATE TO smartexit_scanner_pilot USING (state = 'RUNNING') WITH CHECK (state IN ('COMPLETED', 'FAILED'));

GRANT SELECT, INSERT (symbol, timeframe, exchange, candidate_json, scanned_at),
    UPDATE (exchange, candidate_json, scanned_at)
    ON public.scanner_candidate_snapshots TO smartexit_scanner_pilot;
CREATE POLICY scanner_pilot_snapshots ON public.scanner_candidate_snapshots
    FOR ALL TO smartexit_scanner_pilot
    USING (exchange = 'BINANCE' AND timeframe = '5m')
    WITH CHECK (exchange = 'BINANCE' AND timeframe = '5m');

GRANT SELECT (id, signal_key, scanner_type, strategy_name, exchange, timeframe, setup_score,
              last_signal_updated_at, signal_update_version, repeated_scan_count),
    INSERT (signal_key, scanner_type, exchange, strategy_name, symbol, timeframe, side, setup_score,
            entry_price, entry_zone_low, entry_zone_high, initial_stop, tp1, tp2, tp3, latest_price,
            last_candle_close_at, candle_open_at, expires_at, entry_expires_at, entry_status,
            research_snapshot, source_metadata),
    UPDATE (setup_score, last_signal_updated_at, signal_update_version, last_seen_at,
            latest_price, repeated_scan_count, legacy_scalping_signal_id)
    ON public.market_signals TO smartexit_scanner_pilot;
CREATE POLICY scanner_pilot_signals ON public.market_signals
    FOR ALL TO smartexit_scanner_pilot
    USING (exchange = 'BINANCE' AND timeframe = '5m'
        AND (scanner_type, strategy_name) IN (('STANDARD','STANDARD_TECHNICAL'), ('HIGH_RISK','HIGH_RISK_SCALPING')))
    WITH CHECK (exchange = 'BINANCE' AND timeframe = '5m'
        AND (scanner_type, strategy_name) IN (('STANDARD','STANDARD_TECHNICAL'), ('HIGH_RISK','HIGH_RISK_SCALPING')));

GRANT SELECT (id), INSERT (signal_key, symbol, timeframe, side, setup_score, entry_price,
    entry_zone_low, entry_zone_high, initial_stop, tp1, tp2, last_price,
    candle_open_at, entry_expires_at, expires_at, setup_context)
    ON public.high_risk_scalping_signals TO smartexit_scanner_pilot;
CREATE POLICY scanner_pilot_legacy_high_risk ON public.high_risk_scalping_signals
    FOR ALL TO smartexit_scanner_pilot USING (timeframe = '5m') WITH CHECK (timeframe = '5m');

GRANT SELECT (idempotency_key), INSERT (signal_id, idempotency_key, event_type, payload, event_price, metadata)
    ON public.signal_events TO smartexit_scanner_pilot;
CREATE POLICY scanner_pilot_event_conflict_read ON public.signal_events
    FOR SELECT TO smartexit_scanner_pilot USING (
        event_type IN ('NEW_SIGNAL','SIGNAL_GENERATED','ENTRY_OPEN','SIGNAL_UPDATED')
        AND actor_user_id IS NULL AND EXISTS (SELECT 1 FROM public.market_signals s WHERE s.id = signal_id)
    );
CREATE POLICY scanner_pilot_event_append ON public.signal_events
    FOR INSERT TO smartexit_scanner_pilot WITH CHECK (
        event_type IN ('NEW_SIGNAL','SIGNAL_GENERATED','ENTRY_OPEN','SIGNAL_UPDATED')
        AND actor_user_id IS NULL AND EXISTS (SELECT 1 FROM public.market_signals s WHERE s.id = signal_id)
    );

GRANT SELECT (signal_id),
    INSERT (signal_id, indicator_snapshot, volume_snapshot, market_structure_snapshot,
            derivatives_snapshot, sentiment_snapshot, data_sources)
    ON public.signal_research_snapshots TO smartexit_scanner_pilot;
CREATE POLICY scanner_pilot_research ON public.signal_research_snapshots
    FOR ALL TO smartexit_scanner_pilot
    USING (EXISTS (SELECT 1 FROM public.market_signals s WHERE s.id = signal_id))
    WITH CHECK (EXISTS (SELECT 1 FROM public.market_signals s WHERE s.id = signal_id));

GRANT USAGE ON SEQUENCE public.market_signals_id_seq, public.signal_events_id_seq,
    public.signal_research_snapshots_id_seq, public.high_risk_scalping_signals_id_seq
    TO smartexit_scanner_pilot;
