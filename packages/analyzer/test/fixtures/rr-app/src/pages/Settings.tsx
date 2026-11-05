import { useState } from 'react';

export function SettingsPage() {
  const [theme, setTheme] = useState('light');
  const [email, setEmail] = useState('');
  const saveEmail = () => fetch('/api/email', { method: 'POST', body: email });
  return (
    <section>
      <label>
        Theme
        <select aria-label="Theme" value={theme} onChange={(e) => setTheme(e.target.value)}>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
      <form onSubmit={saveEmail}>
        <input type="email" name="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button type="submit">Change email</button>
      </form>
    </section>
  );
}
