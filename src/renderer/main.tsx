import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { HealthCheckResponse } from '../shared/schemas';
import './styles.css';

declare global {
  interface Window {
    localAgent: { health: () => Promise<HealthCheckResponse> };
  }
}

function App() {
  const [health, setHealth] = useState('checking');

  useEffect(() => {
    void window.localAgent.health().then((result) => setHealth(result.status));
  }, []);

  return (
    <main>
      <p className="eyebrow">LOCAL-FIRST INTELLIGENCE</p>
      <h1>JARVIS</h1>
      <p className="lede">A secure foundation for your personal AI assistant.</p>
      <p className="status">Main process: {health}</p>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
