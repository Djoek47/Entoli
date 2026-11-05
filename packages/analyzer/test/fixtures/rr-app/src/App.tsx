import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import { NotesPage } from './pages/Notes';
import { SettingsPage } from './pages/Settings';

export function App() {
  return (
    <BrowserRouter>
      <nav>
        <Link to="/">Notes</Link>
        <Link to="/settings">Settings</Link>
      </nav>
      <Routes>
        <Route path="/" element={<NotesPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
    </BrowserRouter>
  );
}
