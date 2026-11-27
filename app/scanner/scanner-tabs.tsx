'use client';

export type ScannerTab = 'standard' | 'scalping' | 'alpha';

export function ScannerTabs({
  active,
  onChange,
  showResearch = false,
}: {
  active: ScannerTab;
  onChange: (tab: ScannerTab) => void;
  showResearch?: boolean;
}) {
  return (
    <div className="scanner-tabs" role="tablist" aria-label="Market scanner mode">
      <button
        type="button"
        role="tab"
        aria-selected={active === 'standard'}
        className={active === 'standard' ? 'is-active' : ''}
        onClick={() => onChange('standard')}
      >
        <span>● Standard Signals</span>
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={active === 'scalping'}
        className={active === 'scalping' ? 'is-active' : ''}
        onClick={() => onChange('scalping')}
      >
        <span>⚡ High-Risk Scalping</span>
      </button>
      {showResearch && <button
        type="button"
        role="tab"
        aria-selected={active === 'alpha'}
        className={active === 'alpha' ? 'is-active' : ''}
        onClick={() => onChange('alpha')}
      >
        <span>✦ Alpha Intelligence</span>
      </button>}
    </div>
  );
}
