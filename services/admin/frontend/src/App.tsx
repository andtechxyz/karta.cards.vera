import { Routes, Route } from 'react-router-dom';
import Admin from './pages/Admin';

// Admin UI auth is handled inside <Admin />: Cognito JWT with MFA.
// No static admin API key — the JWT's 'admin' group claim gates access.

export default function App() {
  return (
    <div className="app">
      <Routes>
        <Route path="/" element={<Admin />} />
        <Route path="/admin" element={<Admin />} />
        <Route
          path="*"
          element={
            <div className="page">
              <h1>Not found</h1>
            </div>
          }
        />
      </Routes>
    </div>
  );
}

