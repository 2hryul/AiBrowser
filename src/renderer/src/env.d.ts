/// <reference types="vite/client" />
import type { HelmApi } from '../../shared/api';

declare global {
  interface Window {
    helm: HelmApi;
  }
}
