import { useEffect, useState } from 'preact/hooks';

interface Health {
  status: string;
  app: string;
  time: string;
}

export function App() {
  const [health, setHealth] = useState<Health | { error: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/healthz')
      .then((r) => r.json() as Promise<Health>)
      .then((data) => {
        if (!cancelled) setHealth(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setHealth({ error: String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main class="mx-auto flex min-h-screen max-w-xl flex-col items-start justify-center gap-6 px-6 py-12">
      <h1 class="text-3xl font-semibold tracking-tight">Remind Me</h1>
      <p class="text-zinc-600 dark:text-zinc-400">
        Scaffold up. Auth, reminders, and scheduling land in upcoming milestones.
      </p>
      <pre class="w-full overflow-auto rounded-lg bg-zinc-100 p-4 text-sm dark:bg-zinc-900">
        {health ? JSON.stringify(health, null, 2) : 'Checking /api/healthz…'}
      </pre>
    </main>
  );
}
