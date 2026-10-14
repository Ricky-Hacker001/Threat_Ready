/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Public onboard origin (sign-in, sign-out, profile), e.g. https://onboard.threatready.io */
  readonly VITE_ONBOARD_URL?: string;
}
