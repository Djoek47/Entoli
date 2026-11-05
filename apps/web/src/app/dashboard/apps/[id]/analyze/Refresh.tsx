'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/** Re-renders the server page while a job is running. */
export function Refresh({ everyMs }: { everyMs: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(t);
  }, [router, everyMs]);
  return null;
}
