import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import './index.css';
import { Staging } from './pages/Staging';
import { Queued } from './pages/Queued';
import { Review } from './pages/Review';
import { KB } from './pages/KB';
import { Replies } from './pages/Replies';
import { Facts } from './pages/Facts';
import { Users } from './pages/Users';
import { Sources } from './pages/Sources';
import { Analytics } from './pages/Analytics';
import { SuperAdmin } from './pages/SuperAdmin';
import { Login } from './pages/Login';
import { useSession } from './lib/useSession';

// Redirects to /login when there is no session; renders children once signed in.
function RequireAuth({ children }: { children: ReactNode }) {
  const { session, loading } = useSession();
  if (loading) {
    return <div className="p-6 text-sm text-gray-400">Loading…</div>;
  }
  if (!session) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

// Sends already-signed-in users away from the login page.
function LoginRoute() {
  const { session, loading } = useSession();
  if (loading) return <div className="p-6 text-sm text-gray-400">Loading…</div>;
  if (session) return <Navigate to="/staging" replace />;
  return <Login />;
}

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found');

createRoot(rootEl).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/staging" replace />} />
        <Route path="/login" element={<LoginRoute />} />
        <Route
          path="/staging"
          element={
            <RequireAuth>
              <Staging />
            </RequireAuth>
          }
        />
        <Route
          path="/queued"
          element={
            <RequireAuth>
              <Queued />
            </RequireAuth>
          }
        />
        <Route
          path="/review"
          element={
            <RequireAuth>
              <Review />
            </RequireAuth>
          }
        />
        <Route
          path="/kb"
          element={
            <RequireAuth>
              <KB />
            </RequireAuth>
          }
        />
        <Route
          path="/replies"
          element={
            <RequireAuth>
              <Replies />
            </RequireAuth>
          }
        />
        <Route
          path="/facts"
          element={
            <RequireAuth>
              <Facts />
            </RequireAuth>
          }
        />
        <Route
          path="/users"
          element={
            <RequireAuth>
              <Users />
            </RequireAuth>
          }
        />
        <Route
          path="/sources"
          element={
            <RequireAuth>
              <Sources />
            </RequireAuth>
          }
        />
        <Route
          path="/analytics"
          element={
            <RequireAuth>
              <Analytics />
            </RequireAuth>
          }
        />
        <Route
          path="/admin"
          element={
            <RequireAuth>
              <SuperAdmin />
            </RequireAuth>
          }
        />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
