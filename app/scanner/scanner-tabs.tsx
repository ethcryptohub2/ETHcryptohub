'use client';

export type ScannerTab = 'standard' | 'scalping' | 'alpha';

export function ScannerTabs({
  active,
  onChange,
}: {
  active: ScannerTab;
  onChange: (tab: ScannerTab) => void;
}) {
  return <div className="scanner-tabs" role="tablist" aria-label="Market scanner mode">
    <button type="button" role="tab" aria-selected={active === 'standard'} className={active === 'standard' ? 'is-active' : 'button-secondary'} onClick={() => onChange('standard')}>
      Standard Signals
    </button>
    <button type="button" role="tab" aria-selected={active === 'scalping'} className={active === 'scalping' ? 'is-active' : 'button-secondary'} onClick={() => onChange('scalping')}>
      High-Risk Scalping
    </button>
    <button type="button" role="tab" aria-selected={active === 'alpha'} className={active === 'alpha' ? 'is-active' : 'button-secondary'} onClick={() => onChange('alpha')}>
      Alpha Intelligence
    </button>
  </div>;
}
