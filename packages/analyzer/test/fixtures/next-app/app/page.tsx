import { NewTask } from '@/components/NewTask';

export default function Home() {
  return (
    <main>
      <h1>Tasks</h1>
      <NewTask />
      <a href="/settings">Settings</a>
    </main>
  );
}
