import { useEffect, useState } from 'react';

import { Chat } from './chat/Chat';
import { Onboarding } from './Onboarding';
import { createDefaultSettings } from '../shared/schemas';
import type { Settings } from '../shared/schemas';

type Phase = 'loading' | 'onboarding' | 'ready';

/**
 * Used only when `settings.get` itself did not succeed (denied, or the
 * emergency stop is engaged) — never when settings merely don't exist yet or
 * are corrupt, both of which `main/settings.ts`'s `loadSettings` already
 * resolves to valid defaults before this component ever sees a response. A
 * pure, I/O-free factory from `src/shared`, safe to call from the renderer.
 */
function fallbackSettings(): Settings {
  return createDefaultSettings(new Date().toISOString());
}

export function App() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [health, setHealth] = useState('checking');

  useEffect(() => {
    void window.localAgent.health().then((result) => {
      setHealth(result.status);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;

    void window.localAgent.settings.get().then((result) => {
      if (cancelled) return;
      const loaded =
        result.outcome === 'success' && result.settings ? result.settings : fallbackSettings();
      setSettings(loaded);
      setPhase(loaded.onboardingCompleted ? 'ready' : 'onboarding');
    });

    return () => {
      cancelled = true;
    };
  }, []);

  if (phase === 'loading') {
    return (
      <main>
        <p className="status">Loading…</p>
      </main>
    );
  }

  if (phase === 'onboarding') {
    return (
      <Onboarding
        initialSettings={settings ?? fallbackSettings()}
        onCompleted={(next) => {
          setSettings(next);
          setPhase('ready');
        }}
      />
    );
  }

  const assistantName = settings?.assistant.name ?? 'JARVIS';
  const modelProvider = settings?.modelProvider ?? fallbackSettings().modelProvider;

  return (
    <main className="app-ready">
      <header className="app-header">
        <p className="eyebrow">LOCAL-FIRST INTELLIGENCE</p>
        <h1>{assistantName}</h1>
        {settings && settings.user.displayName.length > 0 && (
          <p className="lede">Welcome back, {settings.user.displayName}.</p>
        )}
        <p className="status">Main process: {health}</p>
      </header>
      <Chat assistantName={assistantName} modelProvider={modelProvider} />
    </main>
  );
}
