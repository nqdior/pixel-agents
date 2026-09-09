import { defineConfig } from '@playwright/test';
import base from './copilot.config';

export default defineConfig({
  ...base,
  testMatch: '**/copilot-vscode.spec.ts',
});
