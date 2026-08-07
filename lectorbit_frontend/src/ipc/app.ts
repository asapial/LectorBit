// Typed wrapper for the LectorBit internal Tauri plugin's app commands.
// Only file in the project allowed to import from `@tauri-apps/api/core`.

import { invoke } from '@tauri-apps/api/core';

export interface AppVersion {
  version: string;
  build: string;
}

export async function getAppVersion(): Promise<AppVersion> {
  return invoke<AppVersion>('plugin:lectorbit|app_get_version');
}