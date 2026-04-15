import { Routes, Route } from 'react-router-dom';
import Admin from './pages/Admin';

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
