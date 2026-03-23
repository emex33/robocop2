import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import Layout from './components/Layout';
import Login from './pages/Login';
import Register from './pages/Register';
import Dashboard from './pages/Dashboard';
import Agents from './pages/Agents';
import Campaigns from './pages/Campaigns';
import CampaignDetail from './pages/CampaignDetail';
import Lists from './pages/Lists';
import Transfers from './pages/Transfers';
import Appointments from './pages/Appointments';
import Softphone from './pages/Softphone';
import AgentUsers from './pages/AgentUsers';
import Settings from './pages/Settings';
import AgentLogin from './pages/AgentLogin';
import AgentSoftphone from './pages/AgentSoftphone';
import Calls from './pages/Calls';
import Callbacks from './pages/Callbacks';
import Billing from './pages/Billing';
import AdminBilling from './pages/AdminBilling';

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-2 border-indigo-600 border-t-transparent rounded-full" />
      </div>
    );
  }
  return user ? children : <Navigate to="/login" />;
}

function PublicRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  return user ? <Navigate to="/" /> : children;
}

function AdminRoute({ children }) {
  const { user, loading, isSuperAdmin } = useAuth();
  if (loading) return null;
  if (!user) return <Navigate to="/login" />;
  return isSuperAdmin ? children : <Navigate to="/" />;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<PublicRoute><Login /></PublicRoute>} />
          <Route path="/register" element={<PublicRoute><Register /></PublicRoute>} />
          <Route path="/agent-login" element={<AgentLogin />} />
          <Route path="/agent/softphone" element={<AgentSoftphone />} />
          <Route path="/" element={<ProtectedRoute><Layout /></ProtectedRoute>}>
            <Route index element={<Dashboard />} />
            <Route path="agents" element={<AdminRoute><Agents /></AdminRoute>} />
            <Route path="campaigns" element={<Campaigns />} />
            <Route path="campaigns/:id" element={<CampaignDetail />} />
            <Route path="lists" element={<Lists />} />
            <Route path="calls" element={<Calls />} />
            <Route path="transfers" element={<Transfers />} />
            <Route path="callbacks" element={<Callbacks />} />
            <Route path="appointments" element={<Appointments />} />
            <Route path="softphone" element={<Softphone />} />
            <Route path="agent-users" element={<AgentUsers />} />
            <Route path="billing" element={<Billing />} />
            <Route path="admin-billing" element={<AdminRoute><AdminBilling /></AdminRoute>} />
            <Route path="settings" element={<Settings />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
