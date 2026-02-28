/**
 * AdminApp.tsx — GPBB Harmoni Admin Dashboard
 *
 * This is the top-level admin component. It handles:
 * - Admin authentication via POST /api/admin/login (session token flow)
 * - Real-time server health polling (5-second interval)
 * - Passphrase management (generate, edit, apply + kick clients)
 * - Audio device selection (triggering cooperative restart on the server)
 * - Soniox translation toggle with optimistic UI
 *
 * Security note (Lesson #11): The login flow MUST await a 200 OK from the
 * server before setting isAuthenticated=true. A previous bug allowed any
 * non-empty password to bypass authentication entirely.
 */
import React, { useState, useEffect } from 'react';
import AudioVisualizer from './components/AudioVisualizer';
import LiveTranscription from './components/LiveTranscription';

const API_ENDPOINT = '/api/admin/token';
const HEALTH_ENDPOINT = '/health';

const WORD_BANK_NOUNS = ['ocean', 'coffee', 'mountain', 'river', 'sky', 'forest', 'island'];
const WORD_BANK_ADJ = ['blue', 'morning', 'quiet', 'swift', 'deep', 'cool', 'bright'];

export default function AdminApp() {
    const [adminPassword, setAdminPassword] = useState('');
    const [adminSessionToken, setAdminSessionToken] = useState('');
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const [loginError, setLoginError] = useState('');

    const [stats, setStats] = useState({ online: false, clients: 0, admins: 0, active: false });
    const [serverReachable, setServerReachable] = useState(false);

    const [draftPassphrase, setDraftPassphrase] = useState('');
    const [activePassphrase, setActivePassphrase] = useState('');
    const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

    const [audioDevices, setAudioDevices] = useState<{ index: number, name: string }[]>([]);
    const [selectedAudioDevice, setSelectedAudioDevice] = useState<number | ''>('');
    const [activeChannels, setActiveChannels] = useState(1);

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoginError('');
        if (adminPassword.trim() !== "") {
            try {
                // AUTH FLOW (Lesson #11): We POST the password to the server and
                // only grant access on a 200 OK with a valid session token. The
                // raw password is cleared from React state immediately after.
                const res = await fetch('/api/admin/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: adminPassword })
                });

                if (res.ok) {
                    const data = await res.json();
                    if (data.access_token && data.refresh_token) {
                        const sToken = data.access_token;
                        setAdminSessionToken(sToken);

                        // Persist refresh token for auto-reconnects
                        localStorage.setItem('admin_refresh_token', data.refresh_token);

                        // SECURITY: Clear the raw password from React state. From this
                        // point forward, only the opaque session token is used for auth.
                        setAdminPassword('');

                        setIsAuthenticated(true);
                        // Immediately fetch dashboard data with the new token
                        fetchStats(sToken);
                        fetchInitialPassphrase(sToken);
                    } else {
                        setLoginError('Server returned unexpected format');
                    }
                } else {
                    setLoginError('Invalid Admin Password');
                }
            } catch (err) {
                setLoginError('Server unreachable');
            }
        }
    };

    /**
     * Intercepts 401 Unauthorized errors from fetch calls, attempts to refresh the access
     * token via the stored refresh token, and retries the original request if successful.
     */
    const fetchWithAuth = async (url: string, options: RequestInit = {}) => {
        let res = await fetch(url, options);

        if (res.status === 401) {
            const refreshToken = localStorage.getItem('admin_refresh_token');
            if (!refreshToken) {
                handleLogout();
                throw new Error("Session expired. No refresh token available.");
            }

            // Try refreshing the token
            const refreshRes = await fetch('/api/admin/refresh', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ refresh_token: refreshToken })
            });

            if (refreshRes.ok) {
                const refreshData = await refreshRes.json();
                const newAccessToken = refreshData.access_token;

                // Update React state safely (if it hasn't unmounted)
                setAdminSessionToken(newAccessToken);

                // Retry the original request with the *new* token
                const newOptions = { ...options };
                if (newOptions.headers) {
                    (newOptions.headers as Record<string, string>)['Authorization'] = `Bearer ${newAccessToken}`;
                }
                return fetch(url, newOptions);
            } else {
                // Refresh failed (e.g. 12 hours expired or invalid)
                handleLogout();
                throw new Error("Session expired. Refresh failed.");
            }
        }

        return res;
    };

    const handleLogout = () => {
        setIsAuthenticated(false);
        setAdminSessionToken('');
        localStorage.removeItem('admin_refresh_token');
    };

    useEffect(() => {
        // Auto-login if a refresh token exists on mount
        const attemptAutoLogin = async () => {
            const refreshToken = localStorage.getItem('admin_refresh_token');
            if (refreshToken) {
                try {
                    const res = await fetch('/api/admin/refresh', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ refresh_token: refreshToken })
                    });
                    if (res.ok) {
                        const data = await res.json();
                        setAdminSessionToken(data.access_token);
                        setIsAuthenticated(true);
                        // Wait a moment and try connecting again, this time the
                        // parent component will eventually pass down the new token
                        fetchStats(data.access_token);
                        fetchInitialPassphrase(data.access_token);
                    } else {
                        localStorage.removeItem('admin_refresh_token');
                    }
                } catch (e) {
                    // Silently fail on network error, user can manually login when it's back
                    console.error("Auto-login failed:", e);
                }
            }
        };
        attemptAutoLogin();
    }, []);

    const fetchInitialPassphrase = async (sToken: string) => {
        try {
            const res = await fetchWithAuth('/api/admin/token', {
                headers: { 'Authorization': `Bearer ${sToken}` }
            });
            if (res.ok) {
                const data = await res.json();
                if (data.active_token) {
                    setActivePassphrase(data.active_token);
                    setDraftPassphrase(prev => prev === '' ? data.active_token : prev);
                }
            }
        } catch (e) {
            console.error("Failed to fetch initial passphrase", e);
        }
    };

    const fetchStats = async (sToken: string = adminSessionToken) => {
        if (!sToken) return;
        try {
            const res = await fetch(HEALTH_ENDPOINT).catch(() => new Response(JSON.stringify({ soniox_connected: false, active_clients: 0, soniox_active: false }), { status: 503 }));
            if (!res.ok) throw new Error("Server offline");
            const data = await res.json();
            setStats({ online: data.soniox_connected, clients: data.active_clients, admins: data.active_admins || 0, active: data.soniox_active });
            setServerReachable(true);
        } catch (e) {
            // Silently handle expected network failures when the server is down
            setStats({ online: false, clients: 0, admins: 0, active: false });
            setServerReachable(false);
        }
    };

    const toggleSoniox = async () => {
        const newActiveState = !stats.active;
        // OPTIMISTIC UI: Update the toggle visually before the server responds.
        // If the request fails, the next health poll (5s) will correct the state.
        setStats(prev => ({ ...prev, active: newActiveState }));
        try {
            await fetchWithAuth('/api/admin/soniox/toggle', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${adminSessionToken}`
                },
                body: JSON.stringify({ active: newActiveState })
            });
            fetchStats();
        } catch (e) {
            console.error("Failed to toggle Soniox connection", e);
        }
    };

    const fetchAudioDevices = async () => {
        if (!adminSessionToken) return;
        try {
            const res = await fetchWithAuth('/api/admin/audio-devices', {
                headers: { 'Authorization': `Bearer ${adminSessionToken}` }
            });
            if (res.ok) {
                const data = await res.json();
                setAudioDevices(data.devices || []);
                setSelectedAudioDevice(data.active_device_index !== null ? data.active_device_index : '');
                setActiveChannels(data.active_channels || 1);
            }
        } catch (e) {
            console.error("Failed to fetch audio devices", e);
        }
    };

    const handleAudioDeviceChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
        const value = e.target.value;
        const newDeviceIndex = value === '' ? null : parseInt(value, 10);
        setSelectedAudioDevice(value === '' ? '' : parseInt(value, 10));

        try {
            const res = await fetchWithAuth('/api/admin/audio-device', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${adminSessionToken}`
                },
                body: JSON.stringify({ device_index: newDeviceIndex })
            });
            if (res.ok) {
                const data = await res.json();
                setActiveChannels(data.active_channels || 1);
            }
        } catch (e) {
            console.error("Failed to update audio device", e);
        }
    };

    useEffect(() => {
        if (!isAuthenticated || !adminSessionToken) return;
        const interval = setInterval(() => fetchStats(adminSessionToken), 5000); // Poll health stats
        fetchAudioDevices();
        return () => clearInterval(interval);
    }, [isAuthenticated, adminSessionToken]);

    const generateRandomPassphrase = () => {
        const adj = WORD_BANK_ADJ[Math.floor(Math.random() * WORD_BANK_ADJ.length)];
        const noun = WORD_BANK_NOUNS[Math.floor(Math.random() * WORD_BANK_NOUNS.length)];
        const num = Math.floor(Math.random() * 99) + 1;
        setDraftPassphrase(`${adj}-${noun}-${num}`);
    };

    const savePassphrase = async () => {
        setSaveStatus('saving');
        try {
            const res = await fetchWithAuth(API_ENDPOINT, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${adminSessionToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ new_token: draftPassphrase })
            });
            if (res.ok) {
                setSaveStatus('saved');
                setActivePassphrase(draftPassphrase);
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
            <div className="flex min-h-[100dvh] items-center justify-center bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-slate-900 via-gray-900 to-black font-sans">
                <form onSubmit={handleLogin} className="bg-slate-800/50 backdrop-blur-xl p-10 rounded-2xl shadow-2xl border border-slate-700/50 max-w-sm w-full mx-4">
                    <div className="flex justify-center mb-6">
                        <div className="p-3 bg-indigo-500/20 rounded-xl">
                            <svg className="w-8 h-8 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                            </svg>
                        </div>
                    </div>
                    <h2 className="text-white text-2xl font-semibold mb-8 text-center tracking-tight">GPBB Harmoni Admin</h2>
                    <input
                        type="password"
                        value={adminPassword}
                        onChange={(e) => setAdminPassword(e.target.value)}
                        placeholder="Enter Admin Password"
                        className="w-full p-3 mb-4 bg-slate-900/50 text-white border border-slate-700/50 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 placeholder-slate-500 transition-all"
                    />
                    {loginError && (
                        <div className="mb-4 text-rose-400 text-sm font-medium text-center">
                            {loginError}
                        </div>
                    )}
                    <button className="w-full bg-gradient-to-r from-indigo-500 to-blue-600 hover:from-indigo-400 hover:to-blue-500 text-white font-medium py-3 rounded-xl shadow-lg shadow-indigo-500/20 transition-all transform hover:scale-[1.02]">
                        Authenticate
                    </button>
                </form>
            </div>
        );
    }

    return (
        <div className="min-h-[100dvh] bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-slate-900 via-gray-900 to-black text-slate-200 p-4 sm:p-8 font-sans">
            <div className="max-w-5xl mx-auto space-y-8">

                <div className="flex items-center space-x-3 mb-8">
                    <div className="p-2 bg-indigo-500/20 rounded-lg">
                        <svg className="w-6 h-6 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                        </svg>
                    </div>
                    <div className="flex-1 flex justify-between items-center">
                        <h1 className="text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-white to-slate-400 tracking-tight">
                            GPBB Harmoni Admin Dashboard
                        </h1>
                        <button
                            onClick={handleLogout}
                            className="bg-slate-800 hover:bg-slate-700 text-slate-300 px-4 py-2 rounded-lg text-sm font-medium transition-colors border border-slate-700"
                        >
                            Log Out
                        </button>
                    </div>
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
                                disabled={!serverReachable}
                                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-slate-900 ${!serverReachable ? 'opacity-50 cursor-not-allowed' : ''} ${stats.active ? 'bg-indigo-500 hover:bg-indigo-400' : 'bg-slate-600 hover:bg-slate-500'}`}
                            >
                                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition duration-200 ease-in-out ${stats.active ? 'translate-x-6' : 'translate-x-1'}`} />
                            </button>
                        </div>

                        <div className={`text-xl font-bold tracking-tight select-none ${stats.online ? 'text-emerald-400' : 'text-slate-500'}`}>
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
                            Refresh Status
                        </button>
                    </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                    {/* Passphrase Management */}
                    <div className="bg-slate-800/40 backdrop-blur-xl p-8 rounded-2xl shadow-xl border border-slate-700/50 flex flex-col justify-between">
                        <div>
                            <h3 className="text-xl font-bold text-white mb-2 tracking-tight">Passphrase Manager</h3>
                            <p className="text-sm text-slate-400 mb-6 leading-relaxed max-w-2xl">
                                This passphrase securely gates the public broadcast. Clients must enter this passphrase to receive the translated audio streams. Applying a new passphrase will disconnect all existing connections.
                            </p>

                            {/* Current Passphrase Prominent Display */}
                            <div className="mb-2 p-6 bg-slate-900/60 rounded-xl border border-slate-700/50 shadow-inner text-center">
                                <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-widest mb-2">Active Public Passphrase</h4>
                                {activePassphrase ? (
                                    <div className="text-xl sm:text-3xl font-mono font-bold text-emerald-400 tracking-wider">
                                        {activePassphrase}
                                    </div>
                                ) : (
                                    <div className="relative group cursor-default text-xl text-slate-500 italic font-mono">
                                        Initializing...
                                        <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-1.5 bg-slate-700 text-white text-xs rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none shadow-lg">
                                            Cannot fetch passphrase. The server may be offline.
                                        </span>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Editor Section Demoted & Inline */}
                        <div className="mt-0">
                            <h4 className="text-xs font-medium text-slate-400 mb-2 uppercase tracking-wider">Change Passphrase</h4>
                            <div className="flex flex-col sm:flex-row gap-2">
                                <input
                                    type="text"
                                    value={draftPassphrase}
                                    onChange={(e) => setDraftPassphrase(e.target.value)}
                                    disabled={!serverReachable}
                                    className={`w-full sm:w-auto sm:max-w-[180px] bg-slate-900/40 border border-slate-700/50 px-3 py-1.5 rounded-lg text-sm tracking-wide text-slate-300 font-mono focus:outline-none focus:border-slate-500 transition-colors ${!serverReachable ? 'opacity-50 cursor-not-allowed' : ''}`}
                                />
                                <div className="flex flex-row gap-2 w-full sm:w-auto">
                                    <button
                                        onClick={generateRandomPassphrase}
                                        disabled={!serverReachable}
                                        className={`flex-1 sm:flex-none px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs font-medium transition-colors text-slate-400 ${serverReachable ? 'hover:bg-slate-700' : 'opacity-50 cursor-not-allowed'}`}
                                    >
                                        Auto-Gen
                                    </button>
                                    <button
                                        onClick={savePassphrase}
                                        disabled={!serverReachable}
                                        className={`flex-1 sm:flex-auto px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${!serverReachable ? 'opacity-50 cursor-not-allowed' : ''} ${saveStatus === 'idle' ? (serverReachable ? 'bg-slate-700 hover:bg-slate-600 text-slate-200' : 'bg-slate-700 text-slate-400') :
                                            saveStatus === 'saving' ? 'bg-slate-600 text-slate-300 animate-pulse' :
                                                saveStatus === 'saved' ? 'bg-emerald-900/30 text-emerald-400 border border-emerald-800/50' :
                                                    'bg-rose-900/30 text-rose-400 border border-rose-800/50'
                                            }`}
                                    >
                                        {saveStatus === 'idle' && 'Apply'}
                                        {saveStatus === 'saving' && '...'}
                                        {saveStatus === 'saved' && 'Saved!'}
                                        {saveStatus === 'error' && 'Failed'}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Live Audio Ingest Visualizer */}
                    <div className="bg-slate-800/40 backdrop-blur-xl p-8 rounded-2xl shadow-xl border border-slate-700/50">
                        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 gap-4">
                            <div>
                                <h3 className="text-xl font-bold text-white tracking-tight">Audio Input</h3>
                                <p className="text-sm text-slate-400 mt-1">Real-time PCM visualization</p>
                            </div>
                            <select
                                value={selectedAudioDevice}
                                onChange={handleAudioDeviceChange}
                                disabled={!serverReachable || audioDevices.length === 0}
                                className={`bg-slate-900/50 border border-slate-700/50 text-white text-sm rounded-lg focus:ring-indigo-500 focus:border-indigo-500 block p-2.5 outline-none transition-colors max-w-[200px] truncate ${(!serverReachable || audioDevices.length === 0) ? 'opacity-50 cursor-not-allowed' : ''}`}
                            >
                                <option value="">Default System Device</option>
                                {audioDevices.map(device => (
                                    <option key={device.index} value={device.index}>
                                        {device.name}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <AudioVisualizer
                            wsEndpoint={`${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws/admin/audio`}
                            adminSessionToken={adminSessionToken}
                            numChannels={activeChannels}
                        />
                    </div>
                </div>

                {/* Live Transcription Monitor */}
                <LiveTranscription sessionToken={activePassphrase} />

            </div>
        </div>
    );
}
