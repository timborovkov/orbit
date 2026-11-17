import { mock } from 'bun:test';

// Integration tests may import web `lib/server` mutations outside Next.js.
mock.module('server-only', () => ({}));
