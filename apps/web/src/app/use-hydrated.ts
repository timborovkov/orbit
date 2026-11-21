'use client';

import { useSyncExternalStore } from 'react';

const subscribe = () => () => undefined;
const clientReady = () => true;
const serverReady = () => false;

export function useHydrated() {
  return useSyncExternalStore(subscribe, clientReady, serverReady);
}
