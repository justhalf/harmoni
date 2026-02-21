import { useState, useEffect, useRef } from 'react';
import TokenPrompt from './components/TokenPrompt';

// Replace with wss://example.com/ws/listen in production
const WS_ENDPOINT = 'ws://localhost:8000/ws/listen';

export default function App() {
    const [sessionToken, setSessionToken] = useState<string | null>(null);
    const [connectionState, setConnectionState] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle');
    const [errorMsg, setErrorMsg] = useState<string>('');
    const [isValidating, setIsValidating] = useState<boolean>(false);

    // State for the streaming text - English
    const [finalTextEn, setFinalTextEn] = useState<string>('');
    const [draftTextEn, setDraftTextEn] = useState<string>('');

    // State for the streaming text - Indonesian
    const [finalTextId, setFinalTextId] = useState<string>('');
    const [draftTextId, setDraftTextId] = useState<string>('');

    const wsRef = useRef<WebSocket | null>(null);
    const scrollRefEn = useRef<HTMLDivElement>(null);
    const scrollRefId = useRef<HTMLDivElement>(null);

    const [reconnectTrigger, setReconnectTrigger] = useState(0);
    const reconnectTimeoutRef = useRef<number | null>(null);

    // Auto-scroll to bottom as new text streams in
    useEffect(() => {
        if (scrollRefEn.current) {
            scrollRefEn.current.scrollTop = scrollRefEn.current.scrollHeight;
        }
        if (scrollRefId.current) {
            scrollRefId.current.scrollTop = scrollRefId.current.scrollHeight;
        }
    }, [finalTextEn, draftTextEn, finalTextId, draftTextId]);

    useEffect(() => {
        if (!sessionToken) return;

        setConnectionState('connecting');
        const ws = new WebSocket(WS_ENDPOINT);
        wsRef.current = ws;

        ws.onopen = () => {
            ws.send(JSON.stringify({ token: sessionToken, is_admin: false }));
            setConnectionState('connected');
            setErrorMsg('');
        };

        ws.onmessage = (event) => {
            try {
                const payload = JSON.parse(event.data);

                if (payload.tokens && Array.isArray(payload.tokens)) {
                    let newFinalEn = '';
                    let newDraftEn = '';
                    let newFinalId = '';
                    let newDraftId = '';

                    payload.tokens.forEach((token: any) => {
                        const isEn = token.language === 'en';

                        if (token.is_final) {
                            if (isEn) newFinalEn += token.text;
                            else newFinalId += token.text;
                        } else {
                            if (isEn) newDraftEn += token.text;
                            else newDraftId += token.text;
                        }
                    });

                    // Update English State
                    if (newFinalEn) setFinalTextEn(prev => prev + newFinalEn);
                    setDraftTextEn(newDraftEn);

                    // Update Indonesian State
                    if (newFinalId) setFinalTextId(prev => prev + newFinalId);
                    setDraftTextId(newDraftId);
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
                setErrorMsg('Connection to server lost. Reconnecting in 3s...');
                // Auto-reconnect
                reconnectTimeoutRef.current = window.setTimeout(() => {
                    setReconnectTrigger(prev => prev + 1);
                }, 3000);
            }
        };

        ws.onerror = (error) => {
            console.error("WebSocket Error:", error);
        };

        return () => {
            ws.onclose = null;
            ws.onerror = null;
            ws.close();
            if (reconnectTimeoutRef.current) {
                clearTimeout(reconnectTimeoutRef.current);
            }
        };
    }, [sessionToken, reconnectTrigger]);

    // Pre-validate token via HTTP before attempting WebSocket connection
    const validateToken = async (token: string) => {
        setIsValidating(true);
        setErrorMsg('');
        try {
            const res = await fetch('http://localhost:8000/api/verify-token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token })
            });
            if (!res.ok) throw new Error("Server unreachable");

            const data = await res.json();
            if (data.valid) {
                setSessionToken(token);
            } else {
                setErrorMsg('Invalid session token. Please try again.');
            }
        } catch (err) {
            setErrorMsg('Could not verify token with the broadcast server.');
            console.error(err);
        } finally {
            setIsValidating(false);
        }
    };

    // Render the token gate if unauthenticated
    if (!sessionToken) {
        return <TokenPrompt onTokenSubmit={validateToken} error={errorMsg} isLoading={isValidating} />;
    }

    // Render the main viewer
    return (
        <div className="min-h-screen bg-[#f2f2f2] p-4 sm:p-8">
            <div className="max-w-4xl mx-auto">

                {/* Header Strip */}
                <div className="flex justify-between items-center mb-6 bg-white p-4 rounded-lg shadow">
                    <div className="flex items-center space-x-4">
                        <h1 className="text-xl font-bold text-gray-800">Live Translation Broadcast</h1>
                        <button
                            onClick={() => {
                                setFinalTextEn('');
                                setDraftTextEn('');
                                setFinalTextId('');
                                setDraftTextId('');
                            }}
                            className="px-3 py-1 bg-gray-100 hover:bg-gray-200 text-gray-600 rounded text-sm font-medium transition-colors"
                        >
                            Clear Text
                        </button>
                    </div>
                    <div className="flex items-center space-x-2">
                        <span className="text-sm text-gray-500">Status:</span>
                        {connectionState === 'connecting' && <span className="text-yellow-500 font-medium">Connecting...</span>}
                        {connectionState === 'connected' && <span className="text-green-500 font-medium">Live</span>}
                        {connectionState === 'error' && <span className="text-red-500 font-medium">Disconnected</span>}
                    </div>
                </div>

                {/* Translation Viewer Container */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {/* Indonesian Box */}
                    <div className="bg-white rounded-lg shadow p-6 border border-gray-100">
                        <div className="text-sm font-semibold text-gray-400 mb-4 border-b pb-2 text-center">
                            Indonesian
                        </div>

                        <div
                            ref={scrollRefId}
                            className="h-[60vh] overflow-y-auto text-xl leading-relaxed font-sans"
                        >
                            {finalTextId === '' && draftTextId === '' ? (
                                <div className="text-gray-400 italic mt-4 text-center">
                                    The original Indonesian speech will appear here...
                                </div>
                            ) : (
                                <p>
                                    <span className="text-gray-900">{finalTextId}</span>
                                    {draftTextId && (
                                        <span className="text-gray-400 transition-opacity duration-200">
                                            {draftTextId}
                                        </span>
                                    )}
                                </p>
                            )}
                        </div>
                    </div>

                    {/* English Box */}
                    <div className="bg-white rounded-lg shadow p-6 border border-gray-100">
                        <div className="text-sm font-semibold text-gray-400 mb-4 border-b pb-2 text-center">
                            English
                        </div>

                        <div
                            ref={scrollRefEn}
                            className="h-[60vh] overflow-y-auto text-xl leading-relaxed font-sans"
                        >
                            {finalTextEn === '' && draftTextEn === '' ? (
                                <div className="text-gray-400 italic mt-4 text-center">
                                    Waiting for the speaker to begin...
                                </div>
                            ) : (
                                <p>
                                    <span className="text-gray-900">{finalTextEn}</span>
                                    {draftTextEn && (
                                        <span className="text-gray-400 transition-opacity duration-200">
                                            {draftTextEn}
                                        </span>
                                    )}
                                </p>
                            )}
                        </div>
                    </div>
                </div>

            </div>
        </div>
    );
}
