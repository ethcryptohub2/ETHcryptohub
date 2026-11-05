import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <main className="shell">
      <section className="hero">
        <p className="mono">ETHCRYPTOHUB</p>
        <h1>Workspace unavailable.</h1>
        <p className="muted">Paper-trading and wallet features have been removed. Use the main dashboard for market information and account tools.</p>
        <a className="button" href="/">Return to ETHcryptohub</a>
      </section>
    </main>
  </React.StrictMode>,
);
