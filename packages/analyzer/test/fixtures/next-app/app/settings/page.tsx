'use client';
export default function SettingsPage() {
  const setLanguage = (v: string) => localStorage.setItem('lang', v);
  return (
    <select name="language" onChange={(e) => setLanguage(e.target.value)}>
      <option value="en">English</option>
      <option value="fr">Français</option>
    </select>
  );
}
