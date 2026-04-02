import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    env: {
      NODE_ENV: 'production',
      WAKE_WORD_PHRASES: '',
      VOICE_WAKE_WORD_ENABLED: 'false',
      LOG_LEVEL: 'silent',
    },
  },
});
