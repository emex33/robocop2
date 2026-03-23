import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import {
  LayoutDashboard, Bot, Phone, PhoneForwarded, CalendarCheck, Megaphone, List, Settings, LogOut, ChevronDown, Headphones, Users, PhoneCall, DollarSign, Shield, PhoneIncoming
} from 'lucide-react';
import { cn } from '../lib/cn';
import { useState } from 'react';

export default function Layout() {
  const { user, logout, creditBalance, isSuperAdmin } = useAuth();
  const navigate = useNavigate();
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  const navItems = [
    { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
    ...(isSuperAdmin ? [{ to: '/agents', icon: Bot, label: 'AI Agents' }] : []),
    { to: '/campaigns', icon: Megaphone, label: 'Campaigns' },
    { to: '/lists', icon: List, label: 'Lists' },
    { to: '/calls', icon: PhoneCall, label: 'Calls' },
    { to: '/transfers', icon: PhoneForwarded, label: 'Transfers' },
    { to: '/callbacks', icon: PhoneIncoming, label: 'Callbacks' },
    { to: '/appointments', icon: CalendarCheck, label: 'Appointments' },
    { to: '/softphone', icon: Headphones, label: 'Softphone' },
    { to: '/agent-users', icon: Users, label: 'Agent Users' },
    { to: '/billing', icon: DollarSign, label: 'Billing' },
    ...(isSuperAdmin ? [{ to: '/admin-billing', icon: Shield, label: 'Admin Billing' }] : []),
    ...(isSuperAdmin ? [{ to: '/settings', icon: Settings, label: 'Settings' }] : []),
  ];

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50">
      {/* Sidebar */}
      <aside className="w-60 bg-white border-r border-gray-200 flex flex-col shrink-0">
        {/* Logo */}
        <div className="h-16 flex-shrink-0 flex items-center px-5 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center">
              <Bot className="w-5 h-5 text-white" />
            </div>
            <span className="font-bold text-lg text-gray-900">ROBOCOP</span>
            <span className="text-xs text-gray-400 font-medium">AI</span>
          </div>
        </div>

        {/* User info */}
        <div className="flex-shrink-0 px-4 py-3 border-b border-gray-100">
          <div
            className="flex items-center gap-2 cursor-pointer rounded-lg px-2 py-1.5 hover:bg-gray-50 transition"
            onClick={() => setUserMenuOpen(!userMenuOpen)}
          >
            <div className="w-7 h-7 bg-indigo-100 rounded-full flex items-center justify-center">
              <span className="text-xs font-semibold text-indigo-600">
                {(user?.name || 'U')[0].toUpperCase()}
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-700 truncate">{user?.name}</p>
              {creditBalance !== null && (
                <p className={`text-xs font-semibold ${creditBalance > 0 ? 'text-green-600' : 'text-red-500'}`}>
                  ${(creditBalance || 0).toFixed(2)}
                </p>
              )}
            </div>
            <ChevronDown className="w-3.5 h-3.5 text-gray-400" />
          </div>
          {userMenuOpen && (
            <div className="mt-1 ml-2">
              <button
                onClick={handleLogout}
                className="flex items-center gap-2 text-sm text-red-600 hover:text-red-700 px-2 py-1.5 rounded hover:bg-red-50 w-full transition"
              >
                <LogOut className="w-3.5 h-3.5" /> Logout
              </button>
            </div>
          )}
        </div>

        {/* Navigation - scrollable so all items visible */}
        <nav className="flex-1 overflow-y-auto min-h-0 px-3 py-4 space-y-1">
          {navItems.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) => cn(
                'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition',
                isActive
                  ? 'bg-indigo-50 text-indigo-700'
                  : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
              )}
            >
              <Icon className="w-4.5 h-4.5" />
              {label}
            </NavLink>
          ))}
        </nav>

        {/* Footer */}
        <div className="flex-shrink-0 px-4 py-3 border-t border-gray-100">
          <p className="text-xs text-gray-400">ROBOCOP v2.0</p>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
