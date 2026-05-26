import { useEffect, useState } from 'preact/hooks';
import { ApiError, type CurrentUser, api } from './api';
import { AdminConsole } from './components/AdminConsole';
import { Dashboard } from './components/Dashboard';
import { Settings } from './components/Settings';
import { SignIn } from './components/SignIn';

type View = 'dashboard' | 'admin' | 'settings';

type State =
  | { kind: 'loading' }
  | { kind: 'signed_out' }
  | { kind: 'signed_in'; user: CurrentUser; view: View };

export function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    api
      .me()
      .then(({ user }) => {
        if (!cancelled) setState({ kind: 'signed_in', user, view: 'dashboard' });
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
    return (
      <SignIn onSignedIn={(user) => setState({ kind: 'signed_in', user, view: 'dashboard' })} />
    );
  }

  if (state.view === 'admin') {
    return (
      <AdminConsole
        admin={state.user}
        onExit={() => setState({ ...state, view: 'dashboard' })}
        onLoggedOut={() => setState({ kind: 'signed_out' })}
        onEnterSettings={() => setState({ ...state, view: 'settings' })}
      />
    );
  }

  if (state.view === 'settings') {
    return (
      <Settings
        user={state.user}
        onExit={() => setState({ ...state, view: 'dashboard' })}
        onLoggedOut={() => setState({ kind: 'signed_out' })}
      />
    );
  }

  const signedInState = state;
  const dashboardProps = {
    user: signedInState.user,
    onUserChanged: (user: CurrentUser) =>
      setState({ kind: 'signed_in', user, view: signedInState.view }),
    onLoggedOut: () => setState({ kind: 'signed_out' }),
    onEnterSettings: () => setState({ ...signedInState, view: 'settings' as const }),
    ...(signedInState.user.isAdmin
      ? { onEnterAdmin: () => setState({ ...signedInState, view: 'admin' as const }) }
      : {}),
  };

  return <Dashboard {...dashboardProps} />;
}
