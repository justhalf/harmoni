import React, { useState, useEffect, useRef } from 'react';
import TokenPrompt from './components/TokenPrompt';

// Replace with wss://example.com/ws/listen in production
const WS_ENDPOINT = 'ws://localhost:8000/ws/listen';

interface TranslationToken {
    text: string;
    is_final: boolean;
    language: string;
}

export default function App() {
    const [sessionToken, setSessionToken] = useState<string | null>(null);
    const [connectionState, setConnectionState] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle');
    const [errorMsg, setErrorMsg] = useState<string>('');

    // State for the streaming text
    const [finalText, setFinalText] = useState<string>('');
    const [draftText, setDraftText] = useState<string>('');

    const wsRef = useRef<WebSocket | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);

    // Auto-scroll to bottom as new text streams in
    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [finalText, draftText]);

    useEffect(() => {
        if (!sessionToken) return;

        setConnectionState('connecting');
        const ws = new WebSocket(`${WS_ENDPOINT}?token=${sessionToken}`);
        wsRef.current = ws;

        ws.onopen = () => {
            setConnectionState('connected');
            setErrorMsg('');
        };

        ws.onmessage = (event) => {
            // The Python server sends Soniox JSON payload
            // According to Soniox docs, it might be an array of tokens
            // For this scaffold, we handle a simplified token object structure
            try {
                const payload = JSON.parse(event.data);

                // Complex state mapping (Simplified for architecture proof)
                // In a true implementation, mapping the exact word indices and `is_final` is key.
                if (payload.is_final) {
                    setFinalText(prev => prev + ' ' + payload.text);
                    setDraftText(''); // Clear draft when a final token lands
                } else {
                    // Replace entire draft view
                    setDraftText(payload.text);
                }
            } catch (err) {
                console.error("Failed to parse token payload", err);
            }
        };

        ws.onclose = (event) => {
            setConnectionState('error');
            if (event.code === 1008) {
                setErrorMsg('Invalid session token. You have been disconnected.');
                setSessionToken(null);
            } else {
                setErrorMsg('Connection to server lost.');
            }
        };

        ws.onerror = (error) => {
            console.error("WebSocket Error:", error);
        };

        return () => {
            ws.close();
        };
    }, [sessionToken]);

    // Render the token gate if unauthenticated
    if (!sessionToken) {
        return <TokenPrompt onTokenSubmit={setSessionToken} error={errorMsg} />;
    }

    // Render the main viewer
    return (
        <div className="min-h-screen bg-[#f2f2f2] p-4 sm:p-8">
            <div className="max-w-4xl mx-auto">

                {/* Header Strip */}
                <div className="flex justify-between items-center mb-6 bg-white p-4 rounded-lg shadow">
                    <h1 className="text-xl font-bold text-gray-800">Live Translation Broadcast</h1>
                    <div className="flex items-center space-x-2">
                        <span className="text-sm text-gray-500">Status:</span>
                        {connectionState === 'connecting' && <span className="text-yellow-500 font-medium">Connecting...</span>}
                        {connectionState === 'connected' && <span className="text-green-500 font-medium">Live</span>}
                        {connectionState === 'error' && <span className="text-red-500 font-medium">Disconnected</span>}
                    </div>
                </div>

                {/* Translation Viewer Container */}
                <div className="bg-white rounded-lg shadow p-6 border border-gray-100">
                    <div className="text-sm font-semibold text-gray-400 mb-4 border-b pb-2">
                        English Translation Stream
                    </div>

                    <div
                        ref={scrollRef}
                        className="h-[60vh] overflow-y-auto text-xl leading-relaxed font-sans"
                    >
                        {finalText === '' && draftText === '' ? (
                            <div className="text-gray-400 italic mt-4 text-center">
                                Waiting for the speaker to begin...
                            </div>
                        ) : (
                            <p>
                                <span className="text-gray-900">{finalText}</span>
                                {draftText && (
                                    <span className="text-gray-400 ml-1 transition-opacity duration-200">
                                        {draftText}
                                    </span>
                                )}
                            </p>
                        )}
                    </div>
                </div>

            </div>
        </div>
    );
}
