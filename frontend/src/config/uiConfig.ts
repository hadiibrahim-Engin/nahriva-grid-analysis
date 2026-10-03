import { createContext, useContext } from 'react';

export interface UiConfig {
  brand: {
    appName: string;
    description: string;
  };
  support: {
    email: string;
    emails: string[];
    accessRequest: {
      subject: string;
      body: string;
    };
  };
  legal: {
    companyName: string;
    rightsText: string;
    confidentialityText: string;
    fullConfidentialityText: string;
  };
  build: {
    fallbackVersion: string;
  };
}

export const UI_CONFIG_URL = '/config/ui-config.json';

export const DEFAULT_UI_CONFIG: UiConfig = {
  brand: {
    appName: 'Outage Assessment',
    description: 'PowerFactory Szenarien und Simulationsergebnisse.',
  },
  support: {
    email: 'developer@example.com',
    emails: ['developer@example.com'],
    accessRequest: {
      subject: 'Zugriff auf Grid Monitor anfragen',
      body: 'Hallo,\n\nich benötige Zugriff auf den Grid Monitor.\n\nName:\nAbteilung:\nBegründung:\n\nVielen Dank.',
    },
  },
  legal: {
    companyName: 'ACME',
    rightsText: 'Alle Rechte vorbehalten.',
    confidentialityText: 'Die bereitgestellten Inhalte sind vertraulich und nur für berechtigte Nutzer bestimmt.',
    fullConfidentialityText: 'Die im Dashboard bereitgestellten Inhalte und Daten sind vertraulich und ausschließlich für berechtigte Nutzer bestimmt. Eine Weitergabe, Vervielfältigung oder Nutzung außerhalb des vorgesehenen Zwecks ist nur mit vorheriger ausdrücklicher Genehmigung von ACME gestattet.',
  },
  build: {
    fallbackVersion: '1.0.0',
  },
};

export const UiConfigContext = createContext<UiConfig>(DEFAULT_UI_CONFIG);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringFrom(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function stringsFrom(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value)) {
    const values = value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean);
    if (values.length > 0) return values;
  }
  if (typeof value === 'string' && value.trim()) {
    const values = value
      .split(/[;,]/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (values.length > 0) return values;
  }
  return fallback;
}

function section(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function mergeUiConfig(value: unknown): UiConfig {
  if (!isRecord(value)) return DEFAULT_UI_CONFIG;

  const brand = section(value.brand);
  const support = section(value.support);
  const accessRequest = section(support.accessRequest);
  const legal = section(value.legal);
  const build = section(value.build);
  const emails = stringsFrom(support.emails, stringsFrom(support.email, DEFAULT_UI_CONFIG.support.emails));

  return {
    brand: {
      appName: stringFrom(brand.appName, DEFAULT_UI_CONFIG.brand.appName),
      description: stringFrom(brand.description, DEFAULT_UI_CONFIG.brand.description),
    },
    support: {
      email: emails[0] ?? DEFAULT_UI_CONFIG.support.email,
      emails,
      accessRequest: {
        subject: stringFrom(accessRequest.subject, DEFAULT_UI_CONFIG.support.accessRequest.subject),
        body: stringFrom(accessRequest.body, DEFAULT_UI_CONFIG.support.accessRequest.body),
      },
    },
    legal: {
      companyName: stringFrom(legal.companyName, DEFAULT_UI_CONFIG.legal.companyName),
      rightsText: stringFrom(legal.rightsText, DEFAULT_UI_CONFIG.legal.rightsText),
      confidentialityText: stringFrom(legal.confidentialityText, DEFAULT_UI_CONFIG.legal.confidentialityText),
      fullConfidentialityText: stringFrom(legal.fullConfidentialityText, DEFAULT_UI_CONFIG.legal.fullConfidentialityText),
    },
    build: {
      fallbackVersion: stringFrom(build.fallbackVersion, DEFAULT_UI_CONFIG.build.fallbackVersion),
    },
  };
}

export function buildMailtoHref(
  email: string | string[],
  options?: { subject?: string; body?: string },
): string {
  const recipients = Array.isArray(email) ? email.join(',') : email;
  const params = [
    options?.subject ? `subject=${encodeURIComponent(options.subject)}` : '',
    options?.body ? `body=${encodeURIComponent(options.body)}` : '',
  ].filter(Boolean);

  return `mailto:${recipients}${params.length > 0 ? `?${params.join('&')}` : ''}`;
}

export function useUiConfig(): UiConfig {
  return useContext(UiConfigContext);
}
