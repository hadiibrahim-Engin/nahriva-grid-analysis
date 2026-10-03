import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  DEFAULT_UI_CONFIG,
  UI_CONFIG_URL,
  UiConfigContext,
  mergeUiConfig,
  type UiConfig,
} from './uiConfig';

export default function UiConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<UiConfig>(DEFAULT_UI_CONFIG);

  useEffect(() => {
    let cancelled = false;

    fetch(UI_CONFIG_URL, { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((json: unknown) => {
        if (!cancelled) setConfig(mergeUiConfig(json));
      })
      .catch(() => {
        if (!cancelled) setConfig(DEFAULT_UI_CONFIG);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const contextValue = useMemo(() => config, [config]);

  return (
    <UiConfigContext.Provider value={contextValue}>
      {children}
    </UiConfigContext.Provider>
  );
}
