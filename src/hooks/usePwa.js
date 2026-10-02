import { useCallback, useEffect, useState } from 'react';

export function useOnline() {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);
  return online;
}

export function useInstallPrompt() {
  const [deferred, setDeferred] = useState(null);

  useEffect(() => {
    const onBeforeInstall = (event) => {
      event.preventDefault();
      setDeferred(event);
    };
    const onInstalled = () => setDeferred(null);
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const install = useCallback(async () => {
    if (!deferred) return 'unavailable';
    await deferred.prompt();
    const { outcome } = await deferred.userChoice;
    setDeferred(null);
    return outcome;
  }, [deferred]);

  const dismiss = useCallback(() => setDeferred(null), []);

  return { canInstall: Boolean(deferred), install, dismiss };
}

export function useServiceWorker() {
  const [updateReady, setUpdateReady] = useState(false);

  useEffect(() => {
    if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return undefined;

    let registration;
    let cancelled = false;

    navigator.serviceWorker.register('/sw.js')
      .then((registered) => {
        if (cancelled) return;
        registration = registered;
        if (registration.waiting && navigator.serviceWorker.controller) setUpdateReady(true);

        registration.addEventListener('updatefound', () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener('statechange', () => {
            if (installing.state === 'installed' && navigator.serviceWorker.controller) setUpdateReady(true);
          });
        });
      })
      .catch(() => undefined);

    const onVisible = () => {
      if (document.visibilityState === 'visible') registration?.update();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const applyUpdate = useCallback(() => {
    navigator.serviceWorker.getRegistration().then((registration) => {
      registration?.waiting?.postMessage('SKIP_WAITING');
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), { once: true });
  }, []);

  return { updateReady, applyUpdate };
}