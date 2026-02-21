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
            const res = await fetch(HEALTH_ENDPOINT);
            const data = await res.json();
            setStats({ online: data.soniox_connected, clients: data.active_clients });
        } catch (e) {
            console.error(e);
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
            <div className="flex h-screen items-center justify-center bg-gray-900">
                <form onSubmit={handleLogin} className="bg-gray-800 p-8 rounded shadow-lg max-w-sm w-full">
                    <h2 className="text-white text-xl mb-4 text-center">Admin Login</h2>
                    <input
                        type="password"
                        value={adminPassword}
                        onChange={(e) => setAdminPassword(e.target.value)}
                        placeholder="Enter Admin Password"
                        className="w-full p-2 mb-4 bg-gray-700 text-white border-none rounded"
                    />
                    <button className="w-full bg-blue-600 hover:bg-blue-500 text-white py-2 rounded">Login</button>
                </form>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-gray-900 text-gray-100 p-8 font-mono">
            <div className="max-w-5xl mx-auto space-y-6">

                {/* Header & Stats Strip */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <div className="bg-gray-800 p-6 rounded-lg shadow border border-gray-700 flex flex-col items-center">
                        <span className="text-gray-400 text-sm mb-2">Translation Pipeline</span>
                        <div className={`text-3xl font-bold ${stats.online ? 'text-green-500' : 'text-red-500'}`}>
                            {stats.online ? 'ONLINE' : 'OFFLINE'}
                        </div>
                        <span className="text-xs text-gray-500 mt-2">Soniox WS Connection</span>
                    </div>

                    <div className="bg-gray-800 p-6 rounded-lg shadow border border-gray-700 flex flex-col items-center">
                        <span className="text-gray-400 text-sm mb-2">Connected Devices</span>
                        <div className="text-3xl font-bold text-blue-400">
                            {stats.clients}
                        </div>
                        <span className="text-xs text-gray-500 mt-2">Active WebSockets</span>
                    </div>

                    <div className="bg-gray-800 p-6 rounded-lg shadow border border-gray-700 flex flex-col items-center justify-center">
                        <span className="text-gray-400 text-sm mb-4">Quick Actions</span>
                        <button onClick={fetchStats} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm transition">
                            Force Refresh Stats
                        </button>
                    </div>
                </div>

                {/* Token Management */}
                <div className="bg-gray-800 p-6 rounded-lg shadow border border-gray-700">
                    <h3 className="text-lg font-semibold text-gray-300 mb-4 border-b border-gray-700 pb-2">Session Token Manager</h3>
                    <p className="text-sm text-gray-400 mb-4">
                        Generates the secret required by listeners to attach to the live broadcast. Updating this immediately locks out old connections.
                    </p>

                    <div className="flex gap-4">
                        <input
                            type="text"
                            value={sessionToken}
                            onChange={(e) => setSessionToken(e.target.value)}
                            className="flex-1 bg-gray-900 border border-gray-600 p-3 rounded text-xl text-center tracking-widest text-green-400"
                        />
                        <button
                            onClick={generateRandomToken}
                            className="px-6 py-2 bg-purple-600 hover:bg-purple-500 rounded font-medium transition"
                        >
                            Auto-Generate
                        </button>
                        <button
                            onClick={saveToken}
                            className="px-6 py-2 bg-blue-600 hover:bg-blue-500 rounded font-medium transition"
                        >
                            {saveStatus === 'idle' && 'Apply & Lock'}
                            {saveStatus === 'saving' && 'Saving...'}
                            {saveStatus === 'saved' && 'Applied!'}
                            {saveStatus === 'error' && 'Failed'}
                        </button>
                    </div>
                </div>

                {/* Live Audio Ingest Visualizer */}
                <div className="bg-gray-800 p-6 rounded-lg shadow border border-gray-700">
                    <div className="flex justify-between items-center border-b border-gray-700 pb-2 mb-4">
                        <h3 className="text-lg font-semibold text-gray-300">Live Audio Hardware Feed (Zero-Latency Queue B)</h3>
                    </div>
                    <AudioVisualizer wsEndpoint={`${WS_ADMIN_AUDIO}?authorization=${adminPassword}`} />
                </div>

            </div>
        </div>
    );
}
