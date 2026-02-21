import { useState, useEffect, useRef } from 'react';


interface LiveTranscriptionProps {
    sessionToken: string;
}

type FontSize = 'small' | 'regular' | 'large';

interface TextSpan {
    id: string;
    ind: string;
    en: string;
    isLineBreak?: boolean;
}

export default function LiveTranscription({ sessionToken }: LiveTranscriptionProps) {
    const [connectionState, setConnectionState] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle');
    const [sonioxActive, setSonioxActive] = useState<boolean>(false);
    const [errorMsg, setErrorMsg] = useState<string>('');

    // Display Settings Menu State
    const [isDisplayMenuOpen, setIsDisplayMenuOpen] = useState(false);
    const [fontSize, setFontSize] = useState<FontSize>(() => {
        return (localStorage.getItem('adminFontSize') as FontSize) || 'regular';
    });

    // Admin uses dark mode by default, but we can allow toggling it back to light/slate
    const [isDarkMode, setIsDarkMode] = useState<boolean>(() => {
        const saved = localStorage.getItem('adminDarkMode');
        return saved ? JSON.parse(saved) : true;
    });

    useEffect(() => {
        localStorage.setItem('adminFontSize', fontSize);
    }, [fontSize]);

    useEffect(() => {
        localStorage.setItem('adminDarkMode', JSON.stringify(isDarkMode));
        if (isDarkMode) {
            document.documentElement.classList.add('dark');
        } else {
            document.documentElement.classList.remove('dark');
        }
    }, [isDarkMode]);

    const getFontSizeClass = () => {
        switch (fontSize) {
            case 'small': return 'text-base sm:text-lg';
            case 'large': return 'text-2xl sm:text-3xl';
            default: return 'text-xl sm:text-2xl';
        }
    };

    // State for the streaming text
    const [spans, setSpans] = useState<TextSpan[]>([]);
    const [draftTextEn, setDraftTextEn] = useState<string>('');
    const [draftTextId, setDraftTextId] = useState<string>('');
    const pendingIndRef = useRef<string>('');

    const wsRef = useRef<WebSocket | null>(null);
    const scrollRefEn = useRef<HTMLDivElement>(null);
    const scrollRefId = useRef<HTMLDivElement>(null);

    // Fade-out parameters
    const [topAlpha, setTopAlpha] = useState(1);

    const generateId = () => Math.random().toString(36).substring(2, 11);

    const handleScroll = () => {
        if (!scrollRefEn.current) return;
        const { scrollTop, scrollHeight, clientHeight } = scrollRefEn.current;
        const fadeThreshold = 200; // pixels to full fade

        if (scrollHeight <= clientHeight + 10) {
            setTopAlpha(1.0);
        } else {
            let opacity = 1.0 - (scrollTop / fadeThreshold);
            if (opacity < 0.2) opacity = 0.2;
            else if (opacity > 1.0) opacity = 1.0;
            setTopAlpha(opacity);
        }

        // Sync scroller for Indonesian
        if (scrollRefId.current) {
            const scrollRatio = scrollTop / (scrollHeight - clientHeight || 1);
            const idHeight = scrollRefId.current.scrollHeight;
            const idClient = scrollRefId.current.clientHeight;
            scrollRefId.current.scrollTop = scrollRatio * (idHeight - idClient);
        }
    };

    const [reconnectTrigger, setReconnectTrigger] = useState(0);
    const reconnectTimeoutRef = useRef<number | null>(null);

    // Auto-scroll to bottom as new text streams in
    useEffect(() => {
        if (scrollRefEn.current) {
            scrollRefEn.current.scrollTop = scrollRefEn.current.scrollHeight;
            handleScroll();
        }
    }, [spans, draftTextEn, draftTextId]);

    useEffect(() => {
        if (!sessionToken) return;

        setConnectionState('connecting');
        const wsHost = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${wsHost}//${window.location.host}/ws/listen`;
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
            ws.send(JSON.stringify({ token: sessionToken, is_admin: true }));
            setConnectionState('connected');
            setErrorMsg('');
        };

        ws.onmessage = (event) => {
            try {
                const payload = JSON.parse(event.data);

                // Handle server-push status updates
                if (payload.type === 'status') {
                    setSonioxActive(payload.soniox_active ?? false);
                    return;
                }

                if (payload.tokens && Array.isArray(payload.tokens)) {
                    // Separate containers for this chunk tick
                    const incomingSpans: TextSpan[] = [];
                    let newDraftId = '';
                    let newDraftEn = '';
                    let currentSpanEn = '';

                    payload.tokens.forEach((token: any) => {
                        const isTranslation = token.translation_status === 'translation' || token.translation_status === 'none';
                        const isOriginal = token.translation_status === 'original' || token.translation_status === 'none' || token.translation_status === undefined;

                        if (token.text === '<end>') {
                            if (token.is_final) {
                                if (currentSpanEn || pendingIndRef.current) {
                                    incomingSpans.push({
                                        id: generateId(),
                                        en: currentSpanEn,
                                        ind: pendingIndRef.current
                                    });
                                    currentSpanEn = '';
                                    pendingIndRef.current = '';
                                }
                                incomingSpans.push({ id: generateId(), en: '', ind: '', isLineBreak: true });
                            }
                            return;
                        }

                        if (token.is_final) {
                            if (isTranslation) {
                                currentSpanEn += token.text;
                            }
                            if (isOriginal) {
                                pendingIndRef.current += token.text;
                            }
                        } else {
                            if (isTranslation) newDraftEn += token.text;
                            if (isOriginal) newDraftId += token.text;
                        }
                    });

                    // Flush any remaining English text at the end of the frame
                    if (currentSpanEn) {
                        incomingSpans.push({
                            id: generateId(),
                            en: currentSpanEn,
                            ind: pendingIndRef.current
                        });
                        pendingIndRef.current = '';
                    }

                    // Update UI states
                    setDraftTextId(newDraftId);

                    if (incomingSpans.length > 0) {
                        setSpans(prev => {
                            const newSpans = [...prev];

                            incomingSpans.forEach(newSpan => {
                                if (newSpans.length === 0) {
                                    newSpans.push(newSpan);
                                    return;
                                }

                                const last = newSpans[newSpans.length - 1];

                                if (!newSpan.isLineBreak && !last.isLineBreak &&
                                    ((last.ind === newSpan.ind && newSpan.ind !== '') ||
                                        (last.ind === '' && newSpan.ind === ''))) {

                                    newSpans[newSpans.length - 1] = {
                                        ...last,
                                        en: last.en + newSpan.en
                                    };
                                } else {
                                    newSpans.push(newSpan);
                                }
                            });

                            return newSpans;
                        });
                    }

                    setDraftTextEn(newDraftEn);
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
        <div
            className={`flex flex-col p-8 rounded-2xl shadow-xl border border-slate-700/50 h-[calc(100vh-1rem)] sm:h-[calc(100vh-2rem)] transition-colors duration-200 ${isDarkMode ? 'bg-slate-900/90 text-slate-100 backdrop-blur-xl' : 'bg-slate-50/90 text-slate-900 border-slate-300 backdrop-blur-xl'}`}
            onClick={() => setIsDisplayMenuOpen(false)}
        >
            {/* Header Strip */}
            <div className={`flex justify-between items-center mb-6 pb-4 shrink-0 border-b ${isDarkMode ? 'border-slate-700/50' : 'border-slate-300'}`}>
                <div className="flex items-center space-x-4">
                    <h3 className={`text-xl font-bold tracking-tight ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>
                        <span className="hidden sm:inline">Live Transcription Monitor</span>
                        <span className="sm:inline hidden"></span><span className="sm:hidden">Monitor</span>
                    </h3>

                    {/* Desktop Center Menu Strip */}
                    <div
                        className={`hidden sm:flex items-center rounded-lg shadow-sm mx-4 relative transition-colors border ${isDarkMode ? 'border-slate-700/50 bg-slate-800/50' : 'border-slate-300 bg-white'}`}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <button
                            disabled
                            onClick={(e) => { e.stopPropagation(); }}
                            className={`rounded-l-lg px-3 py-1.5 flex flex-row items-center justify-center transition-colors border-r focus:outline-none opacity-50 cursor-not-allowed ${isDarkMode ? 'border-slate-700/50 text-slate-400' : 'border-slate-300 text-slate-500'}`}
                        >
                            <svg className="w-4 h-4 mr-1.5" fill="none" viewBox="-2 -2 28 28" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12V9a9 9 0 00-18 0v3m0 0a3 3 0 00-3 3v2a3 3 0 003 3h2a1 1 0 001-1v-6a1 1 0 00-1-1H3m18 0a3 3 0 013 3v2a3 3 0 01-3 3h-2a1 1 0 01-1-1v-6a1 1 0 011-1h2z" /></svg>
                            <span className="text-sm font-medium">Listen</span>
                        </button>
                        <button
                            onClick={(e) => { e.stopPropagation(); setIsDisplayMenuOpen(!isDisplayMenuOpen); }}
                            className={`px-3 py-1.5 flex flex-row items-center justify-center transition-colors border-r focus:outline-none ${isDarkMode ? 'border-slate-700/50 hover:bg-slate-700 hover:text-white' : 'border-slate-300 hover:bg-slate-100 hover:text-slate-900'} ${isDisplayMenuOpen ? (isDarkMode ? 'bg-slate-700 text-white' : 'bg-slate-100 text-slate-900') : (isDarkMode ? 'text-slate-400' : 'text-slate-600')}`}
                        >
                            <svg className="w-4 h-4 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                            <span className="text-sm font-medium">Options</span>
                        </button>
                        <button
                            onClick={() => {
                                setSpans([]);
                                setDraftTextEn('');
                                setDraftTextId('');
                                pendingIndRef.current = '';
                            }}
                            className={`rounded-r-lg px-3 py-1.5 flex flex-row items-center justify-center transition-colors focus:outline-none ${isDarkMode ? 'text-slate-300 hover:text-white hover:bg-slate-700/50' : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'}`}
                        >
                            <svg className="w-4 h-4 mr-1.5 text-rose-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                            <span className="text-sm font-medium">Clear</span>
                        </button>

                        {/* Desktop Display Pull-down */}
                        {isDisplayMenuOpen && (
                            <div
                                className={`absolute top-full left-1/2 -translate-x-1/2 mt-2 w-72 rounded-xl shadow-xl border z-50 p-4 ${isDarkMode ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}
                                onClick={(e) => e.stopPropagation()}
                            >
                                <h3 className={`text-sm font-bold mb-4 uppercase tracking-wider ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>Display Settings</h3>

                                <div className="mb-4">
                                    <label className={`text-xs font-semibold mb-2 block ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>Text Size</label>
                                    <div className={`flex rounded-lg p-1 ${isDarkMode ? 'bg-slate-900' : 'bg-slate-100'}`}>
                                        <button
                                            onClick={() => setFontSize('small')}
                                            className={`flex-1 py-1.5 text-sm font-medium rounded-md transition-colors ${fontSize === 'small' ? (isDarkMode ? 'bg-slate-700 shadow text-white' : 'bg-white shadow text-slate-900') : (isDarkMode ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700')}`}
                                        >
                                            Small
                                        </button>
                                        <button
                                            onClick={() => setFontSize('regular')}
                                            className={`flex-1 py-1.5 text-sm font-medium rounded-md transition-colors ${fontSize === 'regular' ? (isDarkMode ? 'bg-slate-700 shadow text-white' : 'bg-white shadow text-slate-900') : (isDarkMode ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700')}`}
                                        >
                                            Regular
                                        </button>
                                        <button
                                            onClick={() => setFontSize('large')}
                                            className={`flex-1 py-1.5 text-sm font-medium rounded-md transition-colors ${fontSize === 'large' ? (isDarkMode ? 'bg-slate-700 shadow text-white' : 'bg-white shadow text-slate-900') : (isDarkMode ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700')}`}
                                        >
                                            Large
                                        </button>
                                    </div>
                                </div>

                                <div className={`flex items-center justify-between pt-2 border-t ${isDarkMode ? 'border-slate-700' : 'border-slate-200'}`}>
                                    <div className="flex items-center space-x-2">
                                        {isDarkMode ? (
                                            <svg className="w-5 h-5 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" /></svg>
                                        ) : (
                                            <svg className="w-5 h-5 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" /></svg>
                                        )}
                                        <span className={`text-sm font-medium ${isDarkMode ? 'text-slate-300' : 'text-slate-700'}`}>Dark Mode</span>
                                    </div>
                                    <button
                                        onClick={() => setIsDarkMode(!isDarkMode)}
                                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${isDarkMode ? 'bg-indigo-500' : 'bg-slate-300'}`}
                                    >
                                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${isDarkMode ? 'translate-x-6' : 'translate-x-1'}`} />
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
                <div className="flex items-center space-x-2 whitespace-nowrap shrink-0">
                    <span className={`text-sm ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>Status:</span>
                    {connectionState === 'connecting' && <span className="text-yellow-500 font-medium tracking-wide">Connecting...</span>}
                    {connectionState === 'connected' && sonioxActive && (
                        <span className="relative group cursor-default text-emerald-500 font-medium tracking-wide">
                            ● Live
                            <span className={`absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-1.5 text-xs rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none shadow-lg ${isDarkMode ? 'bg-slate-700 text-white' : 'bg-white text-slate-900 border border-slate-200'}`}>
                                Translation streaming is live.
                            </span>
                        </span>
                    )}
                    {connectionState === 'connected' && !sonioxActive && (
                        <span className="relative group cursor-default text-yellow-500 font-medium tracking-wide">
                            ● Stand By
                            <span className={`absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-1.5 text-xs rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none shadow-lg ${isDarkMode ? 'bg-slate-700 text-white' : 'bg-white text-slate-900 border border-slate-200'}`}>
                                Wait for translation streaming to be activated.
                            </span>
                        </span>
                    )}
                    {(connectionState === 'idle' || connectionState === 'error') && (
                        <span className="relative group cursor-default text-rose-500 font-medium tracking-wide">
                            Offline
                            <span className={`absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-1.5 text-xs rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none shadow-lg ${isDarkMode ? 'bg-slate-700 text-white' : 'bg-white text-slate-900 border border-slate-200'}`}>
                                The server is not running. Check back later!
                            </span>
                        </span>
                    )}
                    {errorMsg && <span className="text-rose-500 text-xs ml-2">({errorMsg})</span>}
                </div>
            </div>

            {/* Translation Viewer Container */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 flex-1 min-h-0">
                {/* Indonesian Box */}
                <div className={`flex flex-col min-h-0 rounded-xl p-4 sm:p-6 border shadow-inner transition-colors duration-200 ${isDarkMode ? 'bg-slate-900/50 border-slate-700/50' : 'bg-white border-slate-200'}`}>
                    <div className={`text-sm font-semibold mb-4 border-b pb-2 text-center shrink-0 select-none ${isDarkMode ? 'text-slate-400 border-slate-700/50' : 'text-slate-500 border-slate-200'}`}>
                        Original
                    </div>

                    <div
                        ref={scrollRefId}
                        className={`overflow-y-auto overflow-x-hidden leading-relaxed font-sans scrollbar-thin scrollbar-thumb-slate-600 scrollbar-track-transparent pr-2 flex-1 transition-colors duration-200 ${getFontSizeClass()} ${isDarkMode ? 'text-slate-200' : 'text-slate-800'}`}
                        style={{
                            WebkitMaskImage: `linear-gradient(to bottom, rgba(0,0,0,${topAlpha.toFixed(2)}) 0%, rgba(0,0,0,1) 30%)`,
                            maskImage: `linear-gradient(to bottom, rgba(0,0,0,${topAlpha.toFixed(2)}) 0%, rgba(0,0,0,1) 30%)`,
                            WebkitMaskSize: '100% 100%',
                            maskSize: '100% 100%',
                            WebkitMaskRepeat: 'no-repeat',
                            maskRepeat: 'no-repeat',
                        }}
                    >
                        {spans.length === 0 && draftTextId === '' ? (
                            <div className={`italic mt-4 text-center ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>
                                The original speech will appear here...
                            </div>
                        ) : (
                            <p>
                                {spans.map((span, index) => {
                                    if (span.isLineBreak) {
                                        if (index === 0 || spans[index - 1]?.isLineBreak) return null;
                                        return <div key={`${span.id}-id`} className="h-4 sm:h-6 w-full shrink-0"></div>;
                                    }
                                    return (
                                        <span key={`${span.id}-id`} className="relative transition-colors">
                                            {span.ind}
                                        </span>
                                    );
                                })}
                                {draftTextId && (
                                    <span className={`transition-opacity duration-200 ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>
                                        {draftTextId}
                                    </span>
                                )}
                            </p>
                        )}
                    </div>
                </div>

                {/* English Box */}
                <div className={`flex flex-col min-h-0 rounded-xl p-4 sm:p-6 border shadow-inner transition-colors duration-200 ${isDarkMode ? 'bg-slate-900/50 border-slate-700/50' : 'bg-white border-slate-200'}`}>
                    <div className={`text-sm font-semibold mb-4 border-b pb-2 text-center shrink-0 select-none ${isDarkMode ? 'text-slate-400 border-slate-700/50' : 'text-slate-500 border-slate-200'}`}>
                        English
                    </div>

                    <div
                        ref={scrollRefEn}
                        onScroll={handleScroll}
                        className={`overflow-y-auto overflow-x-hidden leading-relaxed font-sans scrollbar-thin scrollbar-thumb-slate-600 scrollbar-track-transparent pr-2 flex-1 relative transition-colors duration-200 ${getFontSizeClass()} ${isDarkMode ? 'text-slate-200' : 'text-slate-800'}`}
                        style={{
                            WebkitMaskImage: `linear-gradient(to bottom, rgba(0,0,0,${topAlpha.toFixed(2)}) 0%, rgba(0,0,0,1) 30%)`,
                            maskImage: `linear-gradient(to bottom, rgba(0,0,0,${topAlpha.toFixed(2)}) 0%, rgba(0,0,0,1) 30%)`,
                            WebkitMaskSize: '100% 100%',
                            maskSize: '100% 100%',
                            WebkitMaskRepeat: 'no-repeat',
                            maskRepeat: 'no-repeat',
                        }}
                    >
                        {spans.length === 0 && draftTextEn === '' ? (
                            <div className={`italic mt-4 text-center ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>
                                Waiting for the speaker to begin...
                            </div>
                        ) : (
                            <p>
                                {spans.map((span, index) => {
                                    if (span.isLineBreak) {
                                        if (index === 0 || spans[index - 1]?.isLineBreak) return null;
                                        return <div key={span.id} className="h-4 sm:h-6 w-full shrink-0"></div>;
                                    }
                                    return (
                                        <span
                                            key={span.id}
                                            id={`span-${span.id}`}
                                            className="relative transition-colors rounded"
                                        >
                                            {span.en}
                                        </span>
                                    );
                                })}
                                {draftTextEn && (
                                    <span className={`transition-opacity duration-200 ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>
                                        {draftTextEn}
                                    </span>
                                )}
                            </p>
                        )}
                    </div>
                </div>
            </div>

            {/* Mobile Bottom Navigation Bar / Display Dropdown combo */}
            {isDisplayMenuOpen && (
                <div className={`sm:hidden fixed bottom-16 left-2 right-2 rounded-xl shadow-[0_-4px_16px_rgba(0,0,0,0.15)] border z-50 p-4 ${isDarkMode ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`} onClick={(e) => e.stopPropagation()}>
                    <h3 className={`text-sm font-bold mb-4 uppercase tracking-wider ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>Display Settings</h3>

                    <div className="mb-4">
                        <label className={`text-xs font-semibold mb-2 block ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>Text Size</label>
                        <div className={`flex rounded-lg p-1 ${isDarkMode ? 'bg-slate-900' : 'bg-slate-100'}`}>
                            <button
                                onClick={() => setFontSize('small')}
                                className={`flex-1 py-1.5 text-sm font-medium rounded-md transition-colors ${fontSize === 'small' ? (isDarkMode ? 'bg-slate-700 shadow text-white' : 'bg-white shadow text-slate-900') : (isDarkMode ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700')}`}
                            >
                                Small
                            </button>
                            <button
                                onClick={() => setFontSize('regular')}
                                className={`flex-1 py-1.5 text-sm font-medium rounded-md transition-colors ${fontSize === 'regular' ? (isDarkMode ? 'bg-slate-700 shadow text-white' : 'bg-white shadow text-slate-900') : (isDarkMode ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700')}`}
                            >
                                Regular
                            </button>
                            <button
                                onClick={() => setFontSize('large')}
                                className={`flex-1 py-1.5 text-sm font-medium rounded-md transition-colors ${fontSize === 'large' ? (isDarkMode ? 'bg-slate-700 shadow text-white' : 'bg-white shadow text-slate-900') : (isDarkMode ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700')}`}
                            >
                                Large
                            </button>
                        </div>
                    </div>

                    <div className={`flex items-center justify-between pt-2 border-t ${isDarkMode ? 'border-slate-700' : 'border-slate-200'}`}>
                        <div className="flex items-center space-x-2">
                            {isDarkMode ? (
                                <svg className="w-5 h-5 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" /></svg>
                            ) : (
                                <svg className="w-5 h-5 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" /></svg>
                            )}
                            <span className={`text-sm font-medium ${isDarkMode ? 'text-slate-300' : 'text-slate-700'}`}>Dark Mode</span>
                        </div>
                        <button
                            onClick={() => setIsDarkMode(!isDarkMode)}
                            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${isDarkMode ? 'bg-indigo-500' : 'bg-slate-300'}`}
                        >
                            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${isDarkMode ? 'translate-x-6' : 'translate-x-1'}`} />
                        </button>
                    </div>
                </div>
            )}

            <div className={`sm:hidden shrink-0 mt-4 pt-2 flex justify-around items-center z-40 border-t ${isDarkMode ? 'border-slate-700/50' : 'border-slate-300'}`}>
                <button
                    disabled
                    onClick={(e) => { e.stopPropagation(); }}
                    className={`p-2 flex flex-col items-center justify-center focus:outline-none transition-colors text-slate-400 opacity-50 cursor-not-allowed`}
                >
                    <svg className="w-6 h-6 mb-1" fill="none" viewBox="-2 -2 28 28" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12V9a9 9 0 00-18 0v3m0 0a3 3 0 00-3 3v2a3 3 0 003 3h2a1 1 0 001-1v-6a1 1 0 00-1-1H3m18 0a3 3 0 013 3v2a3 3 0 01-3 3h-2a1 1 0 01-1-1v-6a1 1 0 011-1h2z" /></svg>
                    <span className="text-xs font-medium">Listen</span>
                </button>
                <button
                    onClick={(e) => { e.stopPropagation(); setIsDisplayMenuOpen(!isDisplayMenuOpen); }}
                    className={`p-2 flex flex-col items-center justify-center focus:outline-none transition-colors ${isDisplayMenuOpen ? (isDarkMode ? 'text-indigo-400' : 'text-indigo-600') : (isDarkMode ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700')}`}
                >
                    <svg className="w-6 h-6 mb-1" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                    <span className="text-xs font-medium">Options</span>
                </button>
                <button
                    onClick={() => {
                        setSpans([]);
                        setDraftTextEn('');
                        setDraftTextId('');
                        pendingIndRef.current = '';
                    }}
                    className="p-2 flex flex-col items-center justify-center text-rose-400 hover:text-rose-300 focus:outline-none transition-colors"
                >
                    <svg className="w-6 h-6 mb-1" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                    <span className="text-xs font-medium">Clear</span>
                </button>
            </div>
        </div>
    );
}
