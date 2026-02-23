import React, { useState, useEffect } from 'react';

interface TokenPromptProps {
    onTokenSubmit: (token: string) => void;
    error?: string;
    isLoading?: boolean;
}

export default function TokenPrompt({ onTokenSubmit, error, isLoading = false }: TokenPromptProps) {
    const [inputVal, setInputVal] = useState('');
    const [serverStatus, setServerStatus] = useState<'checking' | 'online' | 'offline'>('checking');

    useEffect(() => {
        const checkServer = async () => {
            try {
                const res = await fetch('/health');
                setServerStatus(res.ok ? 'online' : 'offline');
            } catch {
                setServerStatus('offline');
            }
        };
        checkServer();
        const interval = setInterval(checkServer, 5000);
        return () => clearInterval(interval);
    }, []);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (inputVal.trim() && !isLoading) {
            onTokenSubmit(inputVal.trim());
        }
    };

    return (
        <div className="min-h-screen bg-gray-50 flex flex-col justify-center items-center p-4">
            <div className="max-w-md w-full bg-white rounded-lg shadow-lg p-8">
                <h2 className="text-2xl font-bold text-center text-gray-900 mb-2">
                    Live Translation Session
                </h2>

                <div className="flex justify-center mb-6">
                    {serverStatus === 'checking' && (
                        <span className="text-sm text-gray-400 font-medium">Checking server...</span>
                    )}
                    {serverStatus === 'online' && (
                        <span className="relative group cursor-default text-sm text-green-500 font-medium">
                            ● Server Online
                            <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-1.5 bg-gray-800 text-white text-xs rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none shadow-lg">
                                The server is running. Enter your token to connect.
                            </span>
                        </span>
                    )}
                    {serverStatus === 'offline' && (
                        <span className="relative group cursor-default text-sm text-red-500 font-medium">
                            ● Server Offline
                            <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-1.5 bg-gray-800 text-white text-xs rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none shadow-lg">
                                The server is not running. Check back later!
                            </span>
                        </span>
                    )}
                </div>

                <form onSubmit={handleSubmit} className="space-y-4">
                    <div>
                        <label htmlFor="token" className="block text-sm font-medium text-gray-700 mb-1">
                            Enter Today's Session Token
                        </label>
                        <input
                            id="token"
                            type="text"
                            value={inputVal}
                            onChange={(e) => setInputVal(e.target.value)}
                            disabled={serverStatus !== 'online'}
                            className={`w-full px-4 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500 text-black ${serverStatus !== 'online' ? 'opacity-50 cursor-not-allowed bg-gray-100' : ''}`}
                            placeholder="Enter passphrase"
                            required
                        />
                    </div>

                    {error && (
                        <div className="text-red-600 text-sm bg-red-50 p-2 rounded">
                            {error}
                        </div>
                    )}

                    <button
                        type="submit"
                        disabled={isLoading || serverStatus !== 'online'}
                        className={`w-full text-white py-2 px-4 rounded-md transition duration-150 font-medium ${(isLoading || serverStatus !== 'online') ? 'bg-blue-400 cursor-not-allowed opacity-50' : 'bg-blue-600 hover:bg-blue-700'}`}
                    >
                        {isLoading ? 'Verifying...' : 'Connect to Stream'}
                    </button>
                </form>
            </div>
        </div>
    );
}
