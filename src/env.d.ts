import type { LibreDocAPI } from '../shared/types';

declare global {
  interface Window {
    libredoc?: LibreDocAPI;
  }
}

export {};
