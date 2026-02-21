import React, { useState, useEffect } from 'react';
import AudioVisualizer from './components/AudioVisualizer';
import LiveTranscription from './components/LiveTranscription';

const API_ENDPOINT = 'http://localhost:8000/api/admin/token';
const WS_ADMIN_AUDIO = 'ws://localhost:8000/ws/admin/audio'; // Connects to Queue B
const HEALTH_ENDPOINT = 'http://localhost:8000/health';

const WORD_BANK_NOUNS = ['ocean', 'coffee', 'mountain', 'river', 'sky', 'forest', 'island'];
const WORD_BANK_ADJ = ['blue', 'morning', 'quiet', 'swift', 'deep', 'cool', 'bright'];

export default function AdminApp() {
    const [adminPassword, setAdminPassword] = useState('');
    const [isAuthenticated, setIsAuthenticated] = useState(false);

    const [stats, setStats] = useState({ online: false, clients: 0, admins: 0, active: false });

    const [draftToken, setDraftToken] = useState('');
    const [activeToken, setActiveToken] = useState('');
    const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

    const handleLogin = (e: React.FormEvent) => {
        e.preventDefault();
        if (adminPassword.trim() !== "") {
            setIsAuthenticated(true);
            // In production, we'd verify this hash with the server first.
            fetchStats();
            fetchAdminToken();
        }
    };

    const fetchAdminToken = async () => {
        try {
            const res = await fetch('http://localhost:8000/api/admin/token', {
                headers: { 'Authorization': `Bearer ${adminPassword}` }
            });
            if (res.ok) {
                const data = await res.json();
                if (data.active_token) {
                    setActiveToken(data.active_token);
                    setDraftToken(prev => prev === '' ? data.active_token : prev);
                }
            }
        } catch (e) {
            console.error("Failed to fetch admin token", e);
        }
    };

    const fetchStats = async () => {
        try {
            const res = await fetch(HEALTH_ENDPOINT).catch(() => new Response(JSON.stringify({ soniox_connected: false, active_clients: 0, soniox_active: false }), { status: 503 }));
            if (!res.ok) throw new Error("Server offline");
            const data = await res.json();
            setStats({ online: data.soniox_connected, clients: data.active_clients, admins: data.active_admins || 0, active: data.soniox_active });
        } catch (e) {
            // Silently handle expected network failures when the server is down
            setStats({ online: false, clients: 0, admins: 0, active: false });
        }
    };

    const toggleSoniox = async () => {
        const newActiveState = !stats.active;
        // Optimistic UI update
        setStats(prev => ({ ...prev, active: newActiveState }));
        try {
            await fetch('http://localhost:8000/api/admin/soniox/toggle', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${adminPassword}`
                },
                body: JSON.stringify({ active: newActiveState })
            });
            fetchStats();
        } catch (e) {
            console.error("Failed to toggle Soniox connection", e);
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
        setDraftToken(`${adj}-${noun}-${num}`);
    };

    const saveToken = async () => {
        setSaveStatus('saving');
        try {
            const res = await fetch(API_ENDPOINT, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${adminPassword}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ new_token: draftToken })
            });
            if (res.ok) {
                setSaveStatus('saved');
                setActiveToken(draftToken);
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

                        <div className="flex items-center gap-3 mb-3 z-10">
                            <span className="text-xs font-semibold text-slate-500 w-6 text-right">{stats.active ? 'ON' : 'OFF'}</span>
                            <button
                                onClick={toggleSoniox}
                                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-slate-900 ${stats.active ? 'bg-indigo-500 hover:bg-indigo-400' : 'bg-slate-600 hover:bg-slate-500'}`}
                            >
                                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition duration-200 ease-in-out ${stats.active ? 'translate-x-6' : 'translate-x-1'}`} />
                            </button>
                        </div>

                        <div className={`text-xl font-bold tracking-tight ${stats.online ? 'text-emerald-400' : 'text-slate-500'}`}>
                            {stats.online ? 'CONNECTED' : 'STANDBY'}
                        </div>
                    </div>

                    <div className="bg-slate-800/40 backdrop-blur-xl p-6 rounded-2xl shadow-xl border border-slate-700/50 flex flex-col items-center justify-center relative overflow-hidden group">
                        <div className="absolute inset-0 bg-gradient-to-br from-blue-500/5 to-cyan-500/5 opacity-0 group-hover:opacity-100 transition-opacity"></div>
                        <span className="text-slate-400 text-sm font-medium mb-3 uppercase tracking-wider">Active Connections</span>
                        <div className="flex w-full items-center justify-between text-center mt-3 z-10">
                            <div className="flex flex-col flex-1 border-r border-slate-700/50">
                                <div className="text-3xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-indigo-400">
                                    {stats.clients}
                                </div>
                                <span className="text-xs text-slate-500 font-medium tracking-wide mt-1">Public Listeners</span>
                            </div>
                            <div className="flex flex-col flex-1">
                                <div className="text-3xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-purple-400">
                                    {stats.admins}
                                </div>
                                <span className="text-xs text-slate-500 font-medium tracking-wide mt-1">Sys Admins</span>
                            </div>
                        </div>
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

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                    {/* Token Management */}
                    <div className="bg-slate-800/40 backdrop-blur-xl p-8 rounded-2xl shadow-xl border border-slate-700/50">
                        <h3 className="text-xl font-bold text-white mb-2 tracking-tight">Session Token Manager</h3>
                        <p className="text-sm text-slate-400 mb-6 leading-relaxed max-w-2xl">
                            This token securely gates the public broadcast. Listeners must enter this token to receive the translated audio streams. Generating a new token locks out legacy connections.
                        </p>

                        <div className="flex flex-col gap-4">
                            <input
                                type="text"
                                value={draftToken}
                                onChange={(e) => setDraftToken(e.target.value)}
                                className="w-full bg-slate-900/50 border border-slate-700/50 p-4 rounded-xl text-xl text-center tracking-widest text-emerald-400 font-mono shadow-inner focus:outline-none focus:border-indigo-500 transition-colors"
                            />
                            <div className="flex gap-4 w-full">
                                <button
                                    onClick={generateRandomToken}
                                    className="px-6 py-3 flex-1 bg-slate-700/50 hover:bg-slate-600 border border-slate-600/50 rounded-xl font-medium transition-colors text-slate-200"
                                >
                                    Generate Token
                                </button>
                                <button
                                    onClick={saveToken}
                                    className={`px-8 py-3 flex-1 rounded-xl font-medium transition-all shadow-lg min-w-[140px] border border-transparent ${saveStatus === 'idle' ? 'bg-gradient-to-r from-blue-500 to-indigo-600 hover:from-blue-400 hover:to-indigo-500 shadow-indigo-500/25 text-white' :
                                        saveStatus === 'saving' ? 'bg-indigo-500 text-white animate-pulse' :
                                            saveStatus === 'saved' ? 'bg-emerald-500 text-white shadow-emerald-500/25 border-emerald-400' :
                                                'bg-rose-500 text-white shadow-rose-500/25 border-rose-400'
                                        }`}
                                >
                                    {saveStatus === 'idle' && 'Apply'}
                                    {saveStatus === 'saving' && 'Syncing...'}
                                    {saveStatus === 'saved' && 'Enforced!'}
                                    {saveStatus === 'error' && 'Sync Failed'}
                                </button>
                            </div>
                            <div className="text-center text-sm font-medium text-slate-400 mt-2">
                                Current token: <span className="text-indigo-400 italic font-mono px-2">{activeToken || 'Initializing...'}</span>
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
                        <AudioVisualizer wsEndpoint={WS_ADMIN_AUDIO} adminPassword={adminPassword} />
                    </div>
                </div>

                {/* Live Transcription Monitor */}
                <LiveTranscription sessionToken={activeToken} />

            </div>
        </div>
    );
}
