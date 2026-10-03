interface DesktopConfig {
  demoMode: boolean;
  enableMap: boolean;
  backendPort: number;
  dbHost: string;
  dbPort: string;
  dbName: string;
  dbUser: string;
  dbPassword: string;
  secretKey: string;
}

interface ElectronAPI {
  isDesktop: true;
  isSettings: boolean;
  desktopConfig: DesktopConfig | null;
  getConfig(): Promise<DesktopConfig>;
  saveConfig(cfg: DesktopConfig): Promise<{ ok: boolean }>;
  restartApp(): Promise<void>;
  openSettings(): Promise<void>;
}

interface Window {
  electronAPI?: ElectronAPI;
}
