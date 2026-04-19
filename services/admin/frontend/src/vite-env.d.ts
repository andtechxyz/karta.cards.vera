/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_VERA_BASE_URL?: string;
  readonly VITE_PALISADE_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
