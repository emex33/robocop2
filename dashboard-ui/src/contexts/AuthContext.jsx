import { createContext, useContext, useState, useEffect } from 'react';
import { api, setToken, clearToken } from '../lib/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [creditBalance, setCreditBalance] = useState(null);

  const refreshBalance = () => {
    api.getBillingBalance().then(d => setCreditBalance(d.balance)).catch(() => {});
  };

  useEffect(() => {
    const token = localStorage.getItem('robocop_token');
    if (token) {
      api.getProfile()
        .then(u => { setUser(u); refreshBalance(); })
        .catch(() => clearToken())
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  const login = async (email, password) => {
    const res = await api.login(email, password);
    setToken(res.token);
    setUser(res.user);
    refreshBalance();
    return res;
  };

  const register = async (email, password, name, company) => {
    await api.register(email, password, name, company);
    return login(email, password);
  };

  const logout = () => {
    clearToken();
    setUser(null);
    setCreditBalance(null);
  };

  const isSuperAdmin = !!(user?.isSuperAdmin || user?.is_super_admin);

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout, creditBalance, refreshBalance, isSuperAdmin }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
