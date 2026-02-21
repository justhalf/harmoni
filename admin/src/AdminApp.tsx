import React, { useState, useEffect } from 'react';
import AudioVisualizer from './components/AudioVisualizer';

const API_ENDPOINT = 'http://localhost:8000/api/admin/token';
const WS_ADMIN_AUDIO = 'ws://localhost:8000/ws/admin/audio'; // Connects to Queue B
const HEALTH_ENDPOINT = 'http://localhost:8000/health';

const WORD_BANK_NOUNS = ['ocean', 'coffee', 'mountain', 'river', 'sky', 'forest', 'island'];
const WORD_BANK_ADJ = ['blue', 'morning', 'quiet', 'swift', 'deep', 'cool', 'bright'];

export default function AdminApp() {
    const [adminPassword, setAdminPassword] = useState('');
    const [isAuthenticated, setIsAuthenticated] = useState(false);

    const [stats, setStats] = useState({ online: false, clients: 0 });

    const [sessionToken, setSessionToken] = useState('blue-ocean-42');
    const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

    const handleLogin = (e: React.FormEvent) => {
        e.preventDefault();
        if (adminPassword.trim() !== "") {
            setIsAuthenticated(true);
            // In production, we'd verify this hash with the server first.
            fetchStats();
        }
    };

    const fetchStats = async () => {
        try {
            const res = await fetch(HEALTH_ENDPOINT).catch(() => new Response(JSON.stringify({ soniox_connected: false, active_clients: 0 }), { status: 503 }));
            if (!res.ok) throw new Error("Server offline");
            const data = await res.json();
            setStats({ online: data.soniox_connected, clients: data.active_clients });
        } catch (e) {
            // Silently handle expected network failures when the server is down
            setStats({ online: false, clients: 0 });
        }
    };

    useEffect(() => {
        if (!isAuthenticated) return;
        const interval = setInterval(fetchStats, 5000); // Poll health stats
        return () => clearInterval(interval);
    }, [isAuthenticated]);

    const generateRandomToken = () => {
        const adj = WORD_BANK_ADJ[Math.floor(Math.random() * WORD_BANK_ADJ.length)];
        const noun = WORD_BANK_NOUNS[Math.floor(Math.random() * WORD_BANK_NOUNS.length)];
        const num = Math.floor(Math.random() * 99) + 1;
        setSessionToken(`${adj}-${noun}-${num}`);
    };

    const saveToken = async () => {
        setSaveStatus('saving');
        try {
            const res = await fetch(`${API_ENDPOINT}?new_token=${sessionToken}`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${adminPassword}` }
            });
            if (res.ok) {
                setSaveStatus('saved');
                setTimeout(() => setSaveStatus('idle'), 2000);
            } else {
                setSaveStatus('error');
            }
        } catch (e) {
            setSaveStatus('error');
        }
    };

    if (!isAuthenticated) {
        return (
            <div className="flex h-screen items-center justify-center bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-slate-900 via-gray-900 to-black font-sans">
                <form onSubmit={handleLogin} className="bg-slate-800/50 backdrop-blur-xl p-10 rounded-2xl shadow-2xl border border-slate-700/50 max-w-sm w-full mx-4">
                    <div className="flex justify-center mb-6">
                        <div className="p-3 bg-indigo-500/20 rounded-xl">
                            <svg className="w-8 h-8 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                            </svg>
                        </div>
                    </div>
                    <h2 className="text-white text-2xl font-semibold mb-8 text-center tracking-tight">System Admin</h2>
                    <input
                        type="password"
                        value={adminPassword}
                        onChange={(e) => setAdminPassword(e.target.value)}
                        placeholder="Enter Master Password"
                        className="w-full p-3 mb-6 bg-slate-900/50 text-white border border-slate-700/50 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 placeholder-slate-500 transition-all"
                    />
                    <button className="w-full bg-gradient-to-r from-indigo-500 to-blue-600 hover:from-indigo-400 hover:to-blue-500 text-white font-medium py-3 rounded-xl shadow-lg shadow-indigo-500/20 transition-all transform hover:scale-[1.02]">
                        Authenticate
                    </button>
                </form>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-slate-900 via-gray-900 to-black text-slate-200 p-4 sm:p-8 font-sans">
            <div className="max-w-5xl mx-auto space-y-8">

                <div className="flex items-center space-x-3 mb-8">
                    <div className="p-2 bg-indigo-500/20 rounded-lg">
                        <svg className="w-6 h-6 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                        </svg>
                    </div>
                    <h1 className="text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-white to-slate-400 tracking-tight">
                        Broadcast Control Center
                    </h1>
                </div>

                {/* Header & Stats Strip */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <div className="bg-slate-800/40 backdrop-blur-xl p-6 rounded-2xl shadow-xl border border-slate-700/50 flex flex-col items-center justify-center relative overflow-hidden group">
                        <div className="absolute inset-0 bg-gradient-to-br from-indigo-500/5 to-purple-500/5 opacity-0 group-hover:opacity-100 transition-opacity"></div>
                        <span className="text-slate-400 text-sm font-medium mb-3 uppercase tracking-wider">Translation API</span>
                        <div className={`text-3xl font-bold tracking-tight ${stats.online ? 'text-emerald-400' : 'text-rose-400'}`}>
                            {stats.online ? 'ONLINE' : 'OFFLINE'}
                        </div>
                        <span className="text-xs text-slate-500 mt-3 font-medium">Soniox WS Connection</span>
                    </div>

                    <div className="bg-slate-800/40 backdrop-blur-xl p-6 rounded-2xl shadow-xl border border-slate-700/50 flex flex-col items-center justify-center relative overflow-hidden group">
                        <div className="absolute inset-0 bg-gradient-to-br from-blue-500/5 to-cyan-500/5 opacity-0 group-hover:opacity-100 transition-opacity"></div>
                        <span className="text-slate-400 text-sm font-medium mb-3 uppercase tracking-wider">Active Listeners</span>
                        <div className="text-4xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-indigo-400">
                            {stats.clients}
                        </div>
                        <span className="text-xs text-slate-500 mt-3 font-medium">Connected WebSockets</span>
                    </div>

                    <div className="bg-slate-800/40 backdrop-blur-xl p-6 rounded-2xl shadow-xl border border-slate-700/50 flex flex-col items-center justify-center relative overflow-hidden">
                        <span className="text-slate-400 text-sm font-medium mb-4 uppercase tracking-wider">System Checks</span>
                        <button type="button" onClick={(e) => { e.preventDefault(); fetchStats(); }} className="w-full py-2.5 bg-slate-700/50 hover:bg-slate-600/50 border border-slate-600/50 rounded-xl text-sm font-medium text-slate-300 transition-all flex items-center justify-center gap-2 hover:bg-slate-700">
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                            </svg>
                            Refresh Telemetry
                        </button>
                    </div>
                </div>

                {/* Token Management */}
                <div className="bg-slate-800/40 backdrop-blur-xl p-8 rounded-2xl shadow-xl border border-slate-700/50">
                    <h3 className="text-xl font-bold text-white mb-2 tracking-tight">Session Token Manager</h3>
                    <p className="text-sm text-slate-400 mb-6 leading-relaxed max-w-2xl">
                        This token securely gates the public broadcast. Listeners must enter this token to receive the translated audio streams. Generating a new token locks out legacy connections.
                    </p>

                    <div className="flex flex-col sm:flex-row gap-4">
                        <input
                            type="text"
                            value={sessionToken}
                            onChange={(e) => setSessionToken(e.target.value)}
                            className="flex-1 bg-slate-900/50 border border-slate-700/50 p-4 rounded-xl text-xl text-center sm:text-left tracking-widest text-emerald-400 font-mono shadow-inner focus:outline-none focus:border-indigo-500 transition-colors"
                        />
                        <div className="flex gap-4">
                            <button
                                onClick={generateRandomToken}
                                className="px-6 py-3 bg-slate-700/50 hover:bg-slate-600 border border-slate-600/50 rounded-xl font-medium transition-colors text-slate-200"
                            >
                                Roll Token
                            </button>
                            <button
                                onClick={saveToken}
                                className={`px-8 py-3 rounded-xl font-medium transition-all shadow-lg min-w-[140px] border border-transparent ${saveStatus === 'idle' ? 'bg-gradient-to-r from-blue-500 to-indigo-600 hover:from-blue-400 hover:to-indigo-500 shadow-indigo-500/25 text-white' :
                                    saveStatus === 'saving' ? 'bg-indigo-500 text-white animate-pulse' :
                                        saveStatus === 'saved' ? 'bg-emerald-500 text-white shadow-emerald-500/25 border-emerald-400' :
                                            'bg-rose-500 text-white shadow-rose-500/25 border-rose-400'
                                    }`}
                            >
                                {saveStatus === 'idle' && 'Apply Policy'}
                                {saveStatus === 'saving' && 'Syncing...'}
                                {saveStatus === 'saved' && 'Enforced!'}
                                {saveStatus === 'error' && 'Sync Failed'}
                            </button>
                        </div>
                    </div>
                </div>

                {/* Live Audio Ingest Visualizer */}
                <div className="bg-slate-800/40 backdrop-blur-xl p-8 rounded-2xl shadow-xl border border-slate-700/50">
                    <div className="flex justify-between items-center mb-6">
                        <div>
                            <h3 className="text-xl font-bold text-white tracking-tight">Audio Ingest Pipeline</h3>
                            <p className="text-sm text-slate-400 mt-1">Real-time PCM visualization from zero-latency Queue B</p>
                        </div>
                    </div>
                    <AudioVisualizer wsEndpoint={`${WS_ADMIN_AUDIO}?authorization=${adminPassword}`} />
                </div>

            </div>
        </div>
    );
}
