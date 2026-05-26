import { useEffect, useState } from 'preact/hooks';
import { ApiError, type CurrentUser, api } from './api';
import { Dashboard } from './components/Dashboard';
import { SignIn } from './components/SignIn';

type State =
  | { kind: 'loading' }
  | { kind: 'signed_out' }
  | { kind: 'signed_in'; user: CurrentUser };

export function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    api
      .me()
      .then(({ user }) => {
        if (!cancelled) setState({ kind: 'signed_in', user });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          setState({ kind: 'signed_out' });
        } else {
          // Treat unknown errors as signed-out so the user has *some* UI.
          console.error('initial /me check failed', err);
          setState({ kind: 'signed_out' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === 'loading') {
    return (
      <main class="flex min-h-screen items-center justify-center text-zinc-500">Loading…</main>
    );
  }

  if (state.kind === 'signed_out') {
    return <SignIn onSignedIn={(user) => setState({ kind: 'signed_in', user })} />;
  }

  return (
    <Dashboard
      user={state.user}
      onUserChanged={(user) => setState({ kind: 'signed_in', user })}
      onLoggedOut={() => setState({ kind: 'signed_out' })}
    />
  );
}
