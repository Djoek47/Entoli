export default function Note() {
  const archive = () => fetch('/api/archive');
  return <button onClick={archive}>Archive</button>;
}
