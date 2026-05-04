import { useState, useEffect } from 'react';
import { getCurrentUser, signInWithRedirect, signOut } from 'aws-amplify/auth';
import { Hub } from 'aws-amplify/utils';

// Shown while checking auth state
function LoadingScreen() {
  return (
    <div className="h-dvh flex items-center justify-center bg-board-bg">
      <div className="flex flex-col items-center gap-5">
        <div className="text-5xl">&#x1F913;</div>
        <div className="text-board-muted text-base font-medium tracking-wide">Authenticating...</div>
      </div>
    </div>
  );
}

export default function AuthGuard({ children }) {
  const [authState, setAuthState] = useState('loading'); // 'loading' | 'authenticated' | 'unauthenticated'

  useEffect(() => {
    // Handle the OAuth callback — Amplify processes the code param automatically
    // when the page loads with ?code=... in the URL.
    const isCallback = window.location.pathname === '/auth/callback';

    async function checkAuth() {
      try {
        await getCurrentUser();
        setAuthState('authenticated');
        // Clean up the URL after a successful callback
        if (isCallback) {
          window.history.replaceState({}, document.title, '/');
        }
      } catch {
        if (isCallback) {
          // Still processing the OAuth code — Amplify Hub will fire signedIn
          // Leave state as 'loading'
        } else {
          setAuthState('unauthenticated');
        }
      }
    }

    checkAuth();

    // Listen for auth events (e.g. token exchange after callback)
    const unsubscribe = Hub.listen('auth', ({ payload }) => {
      switch (payload.event) {
        case 'signedIn':
          setAuthState('authenticated');
          if (window.location.pathname === '/auth/callback') {
            window.history.replaceState({}, document.title, '/');
          }
          break;
        case 'signedOut':
          setAuthState('unauthenticated');
          break;
        case 'tokenRefresh_failure':
          setAuthState('unauthenticated');
          break;
        default:
          break;
      }
    });

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (authState === 'unauthenticated') {
      signInWithRedirect();
    }
  }, [authState]);

  if (authState === 'loading' || authState === 'unauthenticated') {
    return <LoadingScreen />;
  }

  return children;
}

// Convenience export so any component can trigger logout
export async function handleSignOut() {
  await signOut();
}
