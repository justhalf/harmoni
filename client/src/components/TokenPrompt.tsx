import React, { useState } from 'react';

interface TokenPromptProps {
    onTokenSubmit: (token: string) => void;
    error?: string;
    isLoading?: boolean;
}

export default function TokenPrompt({ onTokenSubmit, error, isLoading = false }: TokenPromptProps) {
    const [inputVal, setInputVal] = useState('');

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (inputVal.trim() && !isLoading) {
            onTokenSubmit(inputVal.trim());
        }
    };

    return (
        <div className="min-h-screen bg-gray-50 flex flex-col justify-center items-center p-4">
            <div className="max-w-md w-full bg-white rounded-lg shadow-lg p-8">
                <h2 className="text-2xl font-bold text-center text-gray-900 mb-6">
                    Live Translation Session
                </h2>

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
                            className="w-full px-4 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500 text-black"
                            placeholder="e.g. blue-ocean-42"
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
                        disabled={isLoading}
                        className={`w-full text-white py-2 px-4 rounded-md transition duration-150 font-medium ${isLoading ? 'bg-blue-400 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700'}`}
                    >
                        {isLoading ? 'Verifying...' : 'Connect to Stream'}
                    </button>
                </form>
            </div>
        </div>
    );
}
