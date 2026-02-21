import { useState, useEffect, useRef } from 'react';

const WS_ENDPOINT = 'ws://localhost:8000/ws/listen';

interface LiveTranscriptionProps {
    sessionToken: string;
}

export default function LiveTranscription({ sessionToken }: LiveTranscriptionProps) {
    const [connectionState, setConnectionState] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle');
    const [errorMsg, setErrorMsg] = useState<string>('');

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
            ws.send(JSON.stringify({ token: sessionToken, is_admin: true }));
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
            } else {
                setErrorMsg('Lost connection. Reconnecting in 3s...');
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

    return (
        <div className="bg-slate-800/40 backdrop-blur-xl p-8 rounded-2xl shadow-xl border border-slate-700/50 mt-8 mb-8">
            {/* Header Strip */}
            <div className="flex justify-between items-center mb-6 border-b border-slate-700/50 pb-4">
                <div className="flex items-center space-x-4">
                    <h3 className="text-xl font-bold text-white tracking-tight">Live Transcription Monitor</h3>
                    <button
                        onClick={() => {
                            setFinalTextEn('');
                            setDraftTextEn('');
                            setFinalTextId('');
                            setDraftTextId('');
                        }}
                        className="px-3 py-1 bg-slate-700/50 hover:bg-slate-600 text-slate-300 rounded text-sm font-medium transition-colors border border-slate-600/50"
                    >
                        Clear Text
                    </button>
                </div>
                <div className="flex items-center space-x-2">
                    <span className="text-sm text-slate-400">Status:</span>
                    {connectionState === 'connecting' && <span className="text-yellow-400 font-medium tracking-wide">Connecting...</span>}
                    {connectionState === 'connected' && <span className="text-emerald-400 font-medium tracking-wide">Live</span>}
                    {connectionState === 'error' && <span className="text-rose-400 font-medium tracking-wide">Disconnected</span>}
                    {errorMsg && <span className="text-rose-400 text-xs ml-2">({errorMsg})</span>}
                </div>
            </div>

            {/* Translation Viewer Container */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Indonesian Box */}
                <div className="bg-slate-900/50 rounded-xl p-6 border border-slate-700/50 shadow-inner">
                    <div className="text-sm font-semibold text-slate-400 mb-4 border-b border-slate-700/50 pb-2 text-center uppercase tracking-wider">
                        Indonesian
                    </div>

                    <div
                        ref={scrollRefId}
                        className="h-[40vh] overflow-y-auto text-lg leading-relaxed font-sans scrollbar-thin scrollbar-thumb-slate-600 scrollbar-track-transparent pr-2"
                    >
                        {finalTextId === '' && draftTextId === '' ? (
                            <div className="text-slate-500 italic mt-4 text-center">
                                The original Indonesian speech will appear here...
                            </div>
                        ) : (
                            <p>
                                <span className="text-slate-200">{finalTextId}</span>
                                {draftTextId && (
                                    <span className="text-slate-500 transition-opacity duration-200">
                                        {draftTextId}
                                    </span>
                                )}
                            </p>
                        )}
                    </div>
                </div>

                {/* English Box */}
                <div className="bg-slate-900/50 rounded-xl p-6 border border-slate-700/50 shadow-inner">
                    <div className="text-sm font-semibold text-slate-400 mb-4 border-b border-slate-700/50 pb-2 text-center uppercase tracking-wider">
                        English
                    </div>

                    <div
                        ref={scrollRefEn}
                        className="h-[40vh] overflow-y-auto text-lg leading-relaxed font-sans scrollbar-thin scrollbar-thumb-slate-600 scrollbar-track-transparent pr-2"
                    >
                        {finalTextEn === '' && draftTextEn === '' ? (
                            <div className="text-slate-500 italic mt-4 text-center">
                                Waiting for the speaker to begin...
                            </div>
                        ) : (
                            <p>
                                <span className="text-slate-200">{finalTextEn}</span>
                                {draftTextEn && (
                                    <span className="text-slate-500 transition-opacity duration-200">
                                        {draftTextEn}
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
