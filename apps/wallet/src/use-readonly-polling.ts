import { useCallback, useEffect, useRef, useState } from 'react';

type PollingOptions<T> = {
  key?: string;
  terminal: boolean;
  scope?: unknown;
  read: () => Promise<T>;
  apply: (value: T) => void;
};

/** Schedules only read requests; a manual refresh shares the same in-flight guard. */
export function useReadonlyPolling<T>(options: PollingOptions<T>) {
  const latest = useRef(options);
  latest.current = options;
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const active = useRef<number | undefined>(undefined);
  const failures = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = useCallback(async () => {
    const current = generation.current;
    const request = latest.current;
    if (!request.key || active.current === current) return;
    clearTimeout(timer.current);
    active.current = current;
    setBusy(true);
    try {
      const value = await request.read();
      if (generation.current !== current) return;
      failures.current = 0;
      setError('');
      request.apply(value);
    } catch (failure) {
      if (generation.current !== current) return;
      failures.current++;
      setError(failure instanceof Error ? failure.message : '状态查询失败');
    } finally {
      if (generation.current === current) {
        active.current = undefined;
        setBusy(false);
        if (latest.current.key && !latest.current.terminal) {
          const delay = [3000, 6000, 12000, 30000][Math.min(failures.current, 3)];
          timer.current = setTimeout(() => { void run(); }, delay);
        }
      }
    }
  }, []);

  useEffect(() => {
    generation.current++;
    failures.current = 0;
    active.current = undefined;
    setBusy(false);
    setError('');
    if (options.key && !options.terminal) timer.current = setTimeout(() => { void run(); }, 3000);
    return () => { generation.current++; clearTimeout(timer.current); };
  }, [options.key, options.terminal, options.scope, run]);

  return { busy, error, refresh: run };
}
