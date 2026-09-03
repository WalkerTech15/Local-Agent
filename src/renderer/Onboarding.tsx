import { useState, type FormEvent } from 'react';

import {
  DEFAULT_ASSISTANT_NAME,
  MODEL_PROVIDERS,
  PROVIDERS_REQUIRING_API_KEY,
  UI_LANGUAGES,
  type ModelProvider,
  type UiLanguage,
} from '../shared/constants';
import type { Settings } from '../shared/schemas';

/** Labels only — no behaviour depends on these strings. */
const LANGUAGE_LABELS: Record<UiLanguage, string> = {
  en: 'English',
  fr: 'Français',
  vi: 'Tiếng Việt',
};

const PROVIDER_LABELS: Record<ModelProvider, string> = {
  none: 'None — configure later',
  glm: 'GLM',
  'openai-compatible': 'OpenAI-compatible endpoint',
  ollama: 'Ollama (local)',
};

interface OnboardingProps {
  readonly initialSettings: Settings;
  /** Called with the freshly persisted, server-reconciled settings. */
  readonly onCompleted: (settings: Settings) => void;
}

/**
 * First-run onboarding: assistant name, user name, interface language and
 * provider settings. Nothing here ever places a key in the settings payload
 * — `apiKey` is submitted separately, through `window.localAgent.secrets.write`,
 * only after `settings.update` has already persisted the provider selection.
 *
 * Client-side checks below (non-empty name, base URL required for
 * `openai-compatible`) exist only so a user sees an error before submitting,
 * not as the actual security boundary — `settingsSchema`, enforced in the
 * main process on every `settings.update` call, is what actually decides
 * whether onboarding is allowed to complete.
 */
export function Onboarding({ initialSettings, onCompleted }: OnboardingProps) {
  const [assistantName, setAssistantName] = useState(initialSettings.assistant.name);
  const [userName, setUserName] = useState(initialSettings.user.displayName);
  const [language, setLanguage] = useState<UiLanguage>(initialSettings.language.ui);
  const [provider, setProvider] = useState<ModelProvider>(initialSettings.modelProvider.provider);
  const [model, setModel] = useState(initialSettings.modelProvider.model);
  const [baseUrl, setBaseUrl] = useState(initialSettings.modelProvider.baseUrl);
  const [apiKey, setApiKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requiresApiKey = PROVIDERS_REQUIRING_API_KEY.includes(provider);
  const requiresBaseUrl = provider === 'openai-compatible';

  function handleSkipProvider(): void {
    setProvider('none');
    setModel('');
    setBaseUrl('');
    setApiKey('');
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);

    const trimmedUserName = userName.trim();
    if (trimmedUserName.length === 0) {
      setError('Your name is required to finish setup.');
      return;
    }
    if (requiresBaseUrl && baseUrl.trim().length === 0) {
      setError('A base URL is required for an OpenAI-compatible endpoint.');
      return;
    }

    setSubmitting(true);
    try {
      const settingsResult = await window.localAgent.settings.update({
        onboardingCompleted: true,
        assistant: { name: assistantName.trim() || DEFAULT_ASSISTANT_NAME },
        user: { displayName: trimmedUserName },
        language: { ui: language },
        modelProvider: { provider, model: model.trim(), baseUrl: baseUrl.trim() },
      });

      if (settingsResult.outcome !== 'success' || !settingsResult.settings) {
        setError('Could not save your settings. Please check the values and try again.');
        setSubmitting(false);
        return;
      }

      let finalSettings = settingsResult.settings;
      const trimmedApiKey = apiKey.trim();

      if (requiresApiKey && trimmedApiKey.length > 0) {
        const secretResult = await window.localAgent.secrets.write(trimmedApiKey);
        // Never retain plaintext in renderer state once it has been sent.
        setApiKey('');

        if (secretResult.outcome === 'aborted') {
          setError(
            'Setup finished, but the API key was not stored because the confirmation was declined. You can add it later in provider settings.',
          );
        } else if (secretResult.outcome !== 'success') {
          setError(
            'Setup finished, but the API key could not be stored securely. You can add it later in provider settings.',
          );
        }

        const refreshed = await window.localAgent.settings.get();
        if (refreshed.outcome === 'success' && refreshed.settings) {
          finalSettings = refreshed.settings;
        }
      }

      onCompleted(finalSettings);
    } catch {
      setError('Something went wrong while saving your settings. Please try again.');
      setSubmitting(false);
    }
  }

  return (
    <form className="onboarding" onSubmit={(event) => void handleSubmit(event)}>
      <p className="eyebrow">FIRST-RUN SETUP</p>
      <h1>Welcome</h1>
      <p className="lede">A few details before your assistant is ready.</p>

      <label className="field">
        <span>Assistant name</span>
        <input
          type="text"
          value={assistantName}
          maxLength={32}
          placeholder={DEFAULT_ASSISTANT_NAME}
          onChange={(event) => {
            setAssistantName(event.target.value);
          }}
        />
      </label>

      <label className="field">
        <span>Your name</span>
        <input
          type="text"
          value={userName}
          maxLength={64}
          required
          onChange={(event) => {
            setUserName(event.target.value);
          }}
        />
      </label>

      <label className="field">
        <span>Interface language</span>
        <select
          value={language}
          onChange={(event) => {
            setLanguage(event.target.value as UiLanguage);
          }}
        >
          {UI_LANGUAGES.map((code) => (
            <option key={code} value={code}>
              {LANGUAGE_LABELS[code]}
            </option>
          ))}
        </select>
      </label>

      <fieldset className="field">
        <legend>Model provider</legend>
        <select
          value={provider}
          onChange={(event) => {
            setProvider(event.target.value as ModelProvider);
          }}
        >
          {MODEL_PROVIDERS.map((value) => (
            <option key={value} value={value}>
              {PROVIDER_LABELS[value]}
            </option>
          ))}
        </select>

        {provider !== 'none' && (
          <>
            <label className="field">
              <span>Model identifier</span>
              <input
                type="text"
                value={model}
                maxLength={128}
                placeholder="e.g. glm-4"
                onChange={(event) => {
                  setModel(event.target.value);
                }}
              />
            </label>

            {(provider === 'openai-compatible' || provider === 'ollama') && (
              <label className="field">
                <span>Base URL{requiresBaseUrl ? ' (required)' : ' (optional)'}</span>
                <input
                  type="text"
                  value={baseUrl}
                  maxLength={2048}
                  placeholder="https://…"
                  required={requiresBaseUrl}
                  onChange={(event) => {
                    setBaseUrl(event.target.value);
                  }}
                />
              </label>
            )}

            {requiresApiKey && (
              <label className="field">
                <span>API key</span>
                <input
                  type="password"
                  value={apiKey}
                  maxLength={4096}
                  autoComplete="off"
                  placeholder="Stored only in the encrypted secret store"
                  onChange={(event) => {
                    setApiKey(event.target.value);
                  }}
                />
              </label>
            )}
          </>
        )}

        {provider !== 'none' && (
          <button type="button" className="secondary" onClick={handleSkipProvider}>
            Skip provider setup for now
          </button>
        )}
      </fieldset>

      {error && <p className="error">{error}</p>}

      <button type="submit" disabled={submitting}>
        {submitting ? 'Saving…' : 'Finish setup'}
      </button>
    </form>
  );
}
