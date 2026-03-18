import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { Headphones } from 'lucide-react';

export default function AgentLogin() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [adminCode, setAdminCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await api.agentLogin(username, password, adminCode);
      localStorage.setItem('robocop_agent_token', res.token);
      localStorage.setItem('robocop_agent', JSON.stringify(res.agent));
      navigate('/agent/softphone');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-900 to-indigo-950">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 bg-indigo-600 rounded-2xl mb-4">
            <Headphones className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-white">Agent Softphone</h1>
          <p className="text-sm text-indigo-300 mt-1">Sign in with your agent credentials</p>
        </div>

        <div className="bg-white/10 backdrop-blur-md rounded-2xl border border-white/10 p-8">
          <form onSubmit={handleSubmit} className="space-y-5">
            {error && (
              <div className="bg-red-500/20 text-red-200 text-sm rounded-lg px-4 py-3 border border-red-500/30">
                {error}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-indigo-200 mb-1.5">Company Code</label>
              <input
                type="text"
                value={adminCode}
                onChange={e => setAdminCode(e.target.value)}
                className="w-full px-3.5 py-2.5 bg-white/10 border border-white/20 rounded-lg text-sm text-white placeholder-indigo-300/50 focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition"
                placeholder="Provided by your admin"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-indigo-200 mb-1.5">Username</label>
              <input
                type="text"
                value={username}
                onChange={e => setUsername(e.target.value)}
                className="w-full px-3.5 py-2.5 bg-white/10 border border-white/20 rounded-lg text-sm text-white placeholder-indigo-300/50 focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition"
                placeholder="Your agent username"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-indigo-200 mb-1.5">Password</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="w-full px-3.5 py-2.5 bg-white/10 border border-white/20 rounded-lg text-sm text-white placeholder-indigo-300/50 focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition"
                placeholder="Your password"
                required
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-indigo-600 text-white py-2.5 rounded-lg text-sm font-semibold hover:bg-indigo-500 disabled:opacity-50 transition"
            >
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
          </form>

          <p className="mt-6 text-center text-xs text-indigo-300/60">
            Admin? <a href="/login" className="text-indigo-400 hover:text-indigo-300 font-medium">Go to admin dashboard</a>
          </p>
        </div>
      </div>
    </div>
  );
}
