import { useState, useEffect, useRef, useCallback } from 'react';
import TokenPrompt from './components/TokenPrompt';

// Replace with wss://example.com/ws/listen in production


interface TextSpan {
    id: string;
    en: string;
    ind: string;
    isLineBreak?: boolean;
}

// Fallback ID generator for non-HTTPS mobile browser contexts where crypto.randomUUID is disabled
const generateId = () => {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
};

// --- HOOKS ---

// Hook to request a Web Screen Wake Lock to prevent mobile devices from sleeping
function useWakeLock() {
    const wakeLockRef = useRef<any>(null);

    const requestWakeLock = useCallback(async () => {
        if ('wakeLock' in navigator) {
            try {
                wakeLockRef.current = await (navigator as any).wakeLock.request('screen');
            } catch (err: any) {
                console.log(`${err.name}, ${err.message}`);
            }
        }
    }, []);

    const releaseWakeLock = useCallback(async () => {
        if (wakeLockRef.current !== null) {
            await wakeLockRef.current.release();
            wakeLockRef.current = null;
        }
    }, []);

    // Re-request wake lock if tab becomes visible again
    useEffect(() => {
        const handleVisibilityChange = async () => {
            if (wakeLockRef.current !== null && document.visibilityState === 'visible') {
                await requestWakeLock();
            }
        };

        document.addEventListener('visibilitychange', handleVisibilityChange);
        return () => {
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            releaseWakeLock();
        };
    }, [requestWakeLock, releaseWakeLock]);

    return { requestWakeLock, releaseWakeLock };
}

// --- MAIN APP ---

type FontSize = 'small' | 'regular' | 'large';

export default function App() {
    const [sessionToken, setSessionToken] = useState<string | null>(null);
    const [connectionState, setConnectionState] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle');
    const [errorMsg, setErrorMsg] = useState('');
    const [isValidating, setIsValidating] = useState(false);
    const [sonioxActive, setSonioxActive] = useState(false);

    // Desktop left panel Indonesian stream
    const [draftTextId, setDraftTextId] = useState('');

    // Dynamic Popover English stream
    const [spans, setSpans] = useState<TextSpan[]>([]);
    const [draftTextEn, setDraftTextEn] = useState('');
    const [activePopover, setActivePopover] = useState<{ id: string; ind: string; } | null>(null);
    const [popoverRect, setPopoverRect] = useState<DOMRect | null>(null);
    const [topAlpha, setTopAlpha] = useState(1);

    // Dark Mode Global State
    const [isDarkMode, setIsDarkMode] = useState(() => {
        // Hydrate from localStorage or default to system preference
        const saved = localStorage.getItem('theme');
        if (saved) return saved === 'dark';
        return window.matchMedia('(prefers-color-scheme: dark)').matches;
    });

    useEffect(() => {
        if (isDarkMode) {
            document.documentElement.classList.add('dark');
            localStorage.setItem('theme', 'dark');
        } else {
            document.documentElement.classList.remove('dark');
            localStorage.setItem('theme', 'light');
        }
    }, [isDarkMode]);

    // Display Settings Menu State
    const [isDisplayMenuOpen, setIsDisplayMenuOpen] = useState(false);
    const [fontSize, setFontSize] = useState<FontSize>(() => {
        return (localStorage.getItem('fontSize') as FontSize) || 'regular';
    });

    useEffect(() => {
        localStorage.setItem('fontSize', fontSize);
    }, [fontSize]);

    const getFontSizeClass = () => {
        switch (fontSize) {
            case 'small': return 'text-base sm:text-lg';   // 80% regular
            case 'large': return 'text-2xl sm:text-3xl';  // 125% regular
            default: return 'text-xl sm:text-2xl';        // 100% regular
        }
    };

    // TTS Options
    const [isTtsEnabled, setIsTtsEnabled] = useState(false);
    const [ttsVolume, setTtsVolume] = useState(() => {
        return parseFloat(localStorage.getItem('ttsVolume') || '1.0');
    });
    const [selectedVoiceURI, setSelectedVoiceURI] = useState(() => {
        return localStorage.getItem('ttsVoice') || '';
    });
    const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);

    useEffect(() => {
        localStorage.setItem('ttsVolume', ttsVolume.toString());
    }, [ttsVolume]);

    useEffect(() => {
        localStorage.setItem('ttsVoice', selectedVoiceURI);
    }, [selectedVoiceURI]);

    useEffect(() => {
        const loadVoices = () => {
            const availableVoices = window.speechSynthesis.getVoices();
            setVoices(availableVoices);
            if (availableVoices.length > 0 && !selectedVoiceURI) {
                // Default to an English voice if available, otherwise first voice
                const defaultVoice = availableVoices.find(v => v.lang.startsWith('en')) || availableVoices[0];
                setSelectedVoiceURI(defaultVoice.voiceURI);
            }
        };

        loadVoices();
        if (window.speechSynthesis.onvoiceschanged !== undefined) {
            window.speechSynthesis.onvoiceschanged = loadVoices;
        }
    }, [selectedVoiceURI]);

    useEffect(() => {
        if (!isTtsEnabled) {
            window.speechSynthesis.cancel();
        }
    }, [isTtsEnabled]);

    // Refs for TTS settings to avoid WS reconnects on state changes
    const ttsSettingsRef = useRef({
        enabled: isTtsEnabled,
        volume: ttsVolume,
        voiceURI: selectedVoiceURI,
        voices: voices
    });

    useEffect(() => {
        ttsSettingsRef.current = {
            enabled: isTtsEnabled,
            volume: ttsVolume,
            voiceURI: selectedVoiceURI,
            voices: voices
        };
    }, [isTtsEnabled, ttsVolume, selectedVoiceURI, voices]);

    const ttsBufferRef = useRef('');

    // Buffer for Indonesian words arriving before English chunks
    const pendingIndRef = useRef('');

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
    }, [spans, draftTextEn, draftTextId]);

    const updatePopoverPosition = () => {
        if (scrollRefEn.current) {
            const el = scrollRefEn.current;
            const containerH = el.clientHeight;
            const contentH = el.firstElementChild?.clientHeight || 0;
            const fullness = containerH > 0 ? Math.min(1, contentH / containerH) : 0;
            setTopAlpha(1.0 - (0.7 * fullness));

            // Sync scroller for Indonesian
            if (scrollRefId.current) {
                const scrollTop = el.scrollTop;
                const scrollHeight = el.scrollHeight;
                const scrollRatio = scrollTop / (scrollHeight - containerH || 1);
                const idHeight = scrollRefId.current.scrollHeight;
                const idClient = scrollRefId.current.clientHeight;
                scrollRefId.current.scrollTop = scrollRatio * (idHeight - idClient);
            }
        }

        if (!activePopover) return;
        const el = document.getElementById(`span-${activePopover.id}`);
        if (!el) {
            setPopoverRect(null);
            return;
        }

        const rect = el.getBoundingClientRect();
        const container = scrollRefEn.current?.getBoundingClientRect();

        // Hide popover if the clicked span scrolls completely out of the English box bounds
        if (container) {
            if (rect.bottom < container.top || rect.top > container.bottom) {
                setPopoverRect(null);
                return;
            }
        }
        setPopoverRect(rect);
    };

    // Update position whenever text changes or window resizes
    useEffect(() => {
        updatePopoverPosition();
    }, [activePopover, spans, draftTextEn]);

    useEffect(() => {
        window.addEventListener('resize', updatePopoverPosition);
        return () => window.removeEventListener('resize', updatePopoverPosition);
    }, [activePopover]);

    const { requestWakeLock, releaseWakeLock } = useWakeLock();

    useEffect(() => {
        if (!sessionToken) return;

        // Try to grab wake lock when session starts (may require a user click first on some mobile browsers)
        requestWakeLock();

        setConnectionState('connecting');
        const wsHost = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${wsHost}//${window.location.host}/ws/listen`;
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
            ws.send(JSON.stringify({ token: sessionToken, is_admin: false }));
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
                    let newFinalId = '';
                    let newDraftId = '';
                    let newDraftEn = '';
                    let currentSpanEn = '';

                    payload.tokens.forEach((token: any) => {
                        // Per user request, STRICT routing based on Soniox doc status
                        const isTranslation = token.translation_status === 'translation' || token.translation_status === 'none';
                        const isOriginal = token.translation_status === 'original' || token.translation_status === 'none' || token.translation_status === undefined;

                        // Handle <end> marker spacing explicitly as a layout block rather than \n text
                        // This prevents highlight bugs and popovers attaching to invisible space
                        if (token.text === '<end>') {
                            if (token.is_final) {
                                // Flush TTS buffer if enabled
                                const tts = ttsSettingsRef.current;
                                if (tts.enabled && ttsBufferRef.current.trim()) {
                                    const utterance = new SpeechSynthesisUtterance(ttsBufferRef.current.trim());
                                    utterance.volume = tts.volume;
                                    const voice = tts.voices.find(v => v.voiceURI === tts.voiceURI);
                                    if (voice) utterance.voice = voice;
                                    window.speechSynthesis.speak(utterance);
                                }
                                ttsBufferRef.current = '';

                                // Flush anything currently in the buffer before adding the break
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
                            return; // Skip normal text processing for <end>
                        }

                        if (token.is_final) {
                            if (isTranslation) {
                                // Accumulate translation text within this frame
                                currentSpanEn += token.text;
                                ttsBufferRef.current += token.text;
                            }
                            if (isOriginal) {
                                // Accumulate original text to be attached to the upcoming translation
                                newFinalId += token.text;
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

                                // Consolidate consecutive spans IF AND ONLY IF they share the exact same Indonesian context
                                // meaning they belong to the same translation block.
                                // Linebreaks are never consolidated with text.
                                if (!newSpan.isLineBreak && !last.isLineBreak &&
                                    ((last.ind === newSpan.ind && newSpan.ind !== '') ||
                                        (last.ind === '' && newSpan.ind === ''))) {

                                    newSpans[newSpans.length - 1] = {
                                        ...last,
                                        en: last.en + newSpan.en
                                    };
                                } else {
                                    // Differing context or it's a linebreak -> push as distinct span
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
            releaseWakeLock();
        };
    }, [sessionToken, reconnectTrigger, requestWakeLock, releaseWakeLock]);

    // Pre-validate token via HTTP before attempting WebSocket connection
    const validateToken = async (token: string) => {
        setIsValidating(true);
        setErrorMsg('');
        try {
            const res = await fetch('/api/verify-token', {
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
        <div
            className="h-full overflow-hidden bg-[#f2f2f2] dark:bg-gray-900 p-2 sm:p-8 flex flex-col transition-colors duration-200"
            onClick={() => {
                setActivePopover(null);
                setIsDisplayMenuOpen(false);
                // Secondary attempt: Browsers often require a direct user interaction to grant Wake Lock. 
                // Any tap anywhere on the app will attempt to grab the lock if we don't already have it.
                requestWakeLock();
            }}
        >
            <div className="max-w-4xl mx-auto w-full flex-1 flex flex-col min-h-0">

                {/* Header Strip */}
                <div className="flex justify-between items-center mb-2 sm:mb-6 bg-white dark:bg-gray-800 p-3 sm:p-4 rounded-lg shadow shrink-0 transition-colors duration-200">
                    <div className="flex items-center space-x-4">
                        <h1 className="text-lg sm:text-xl font-bold text-gray-800 dark:text-gray-100">
                            <span className="hidden sm:inline">GPBB Harmoni Translation</span>
                            <span className="sm:hidden">GPBB Harmoni</span>
                        </h1>
                    </div>

                    {/* Desktop Center Menu Strip */}
                    <div className="hidden sm:flex items-center rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm mx-4 relative" onClick={(e) => e.stopPropagation()}>
                        <button
                            onClick={(e) => { e.stopPropagation(); setIsTtsEnabled(!isTtsEnabled); }}
                            className={`rounded-l-lg px-4 py-2 flex flex-row items-center justify-center transition-colors border-r border-gray-200 dark:border-gray-700 focus:outline-none ${isTtsEnabled ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-gray-900 dark:hover:text-gray-100'}`}
                        >
                            <svg className="w-5 h-5 mr-1.5" fill="none" viewBox="-2 -2 28 28" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12V9a9 9 0 00-18 0v3m0 0a3 3 0 00-3 3v2a3 3 0 003 3h2a1 1 0 001-1v-6a1 1 0 00-1-1H3m18 0a3 3 0 013 3v2a3 3 0 01-3 3h-2a1 1 0 01-1-1v-6a1 1 0 011-1h2z" /></svg>
                            <span className="text-sm font-medium">Listen</span>
                        </button>
                        <button
                            onClick={(e) => { e.stopPropagation(); setIsDisplayMenuOpen(!isDisplayMenuOpen); }}
                            className={`px-4 py-2 flex flex-row items-center justify-center transition-colors border-r border-gray-200 dark:border-gray-700 focus:outline-none ${isDisplayMenuOpen ? 'bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-white' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-gray-900 dark:hover:text-gray-100'}`}
                        >
                            <svg className="w-5 h-5 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                            <span className="text-sm font-medium">Options</span>
                        </button>
                        <button
                            disabled
                            onClick={(e) => { e.stopPropagation(); }}
                            className="rounded-r-lg px-4 py-2 flex flex-row items-center justify-center transition-colors text-gray-400 dark:text-gray-500 focus:outline-none opacity-50 cursor-not-allowed"
                        >
                            <svg className="w-5 h-5 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
                            <span className="text-sm font-medium">You</span>
                        </button>

                        {/* Desktop Display Pull-down */}
                        {isDisplayMenuOpen && (
                            <div
                                className="absolute top-full left-1/2 -translate-x-1/2 mt-2 w-72 bg-white dark:bg-gray-800 rounded-xl shadow-xl border border-gray-200 dark:border-gray-700 z-50 p-4"
                                onClick={(e) => e.stopPropagation()}
                            >
                                <h3 className="text-sm font-bold text-gray-900 dark:text-white mb-4 uppercase tracking-wider">Display Settings</h3>

                                <div className="mb-4">
                                    <label className="text-xs text-gray-500 dark:text-gray-400 font-semibold mb-2 block">Text Size</label>
                                    <div className="flex bg-gray-100 dark:bg-gray-900 rounded-lg p-1">
                                        <button
                                            onClick={() => setFontSize('small')}
                                            className={`flex-1 py-1.5 text-sm font-medium rounded-md transition-colors ${fontSize === 'small' ? 'bg-white dark:bg-gray-700 shadow text-gray-900 dark:text-white' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}
                                        >
                                            Small
                                        </button>
                                        <button
                                            onClick={() => setFontSize('regular')}
                                            className={`flex-1 py-1.5 text-sm font-medium rounded-md transition-colors ${fontSize === 'regular' ? 'bg-white dark:bg-gray-700 shadow text-gray-900 dark:text-white' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}
                                        >
                                            Regular
                                        </button>
                                        <button
                                            onClick={() => setFontSize('large')}
                                            className={`flex-1 py-1.5 text-sm font-medium rounded-md transition-colors ${fontSize === 'large' ? 'bg-white dark:bg-gray-700 shadow text-gray-900 dark:text-white' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}
                                        >
                                            Large
                                        </button>
                                    </div>
                                </div>

                                <div className="mb-4">
                                    <label className="text-xs text-gray-500 dark:text-gray-400 font-semibold mb-2 block">Voice Volume</label>
                                    <input
                                        type="range" min="0" max="1" step="0.1"
                                        value={ttsVolume}
                                        onChange={(e) => setTtsVolume(parseFloat(e.target.value))}
                                        className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer dark:bg-gray-700 accent-blue-500"
                                    />
                                </div>

                                {voices.length > 0 && (
                                    <div className="mb-4">
                                        <label className="text-xs text-gray-500 dark:text-gray-400 font-semibold mb-2 block">Voice Selection</label>
                                        <select
                                            value={selectedVoiceURI}
                                            onChange={(e) => setSelectedVoiceURI(e.target.value)}
                                            className="w-full bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-600 text-gray-900 dark:text-white text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block p-2"
                                        >
                                            {voices.filter(v => v.lang.startsWith('en') || v.lang.startsWith('id')).map(voice => (
                                                <option key={voice.voiceURI} value={voice.voiceURI}>
                                                    {voice.name}
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                )}

                                <div className="flex items-center justify-between pt-2 border-t border-gray-100 dark:border-gray-700">
                                    <div className="flex items-center space-x-2">
                                        {isDarkMode ? (
                                            <svg className="w-5 h-5 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" /></svg>
                                        ) : (
                                            <svg className="w-5 h-5 text-yellow-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" /></svg>
                                        )}
                                        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Dark Mode</span>
                                    </div>
                                    <button
                                        onClick={() => setIsDarkMode(!isDarkMode)}
                                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${isDarkMode ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
                                    >
                                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${isDarkMode ? 'translate-x-6' : 'translate-x-1'}`} />
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>

                    <div className="flex items-center space-x-2 whitespace-nowrap">
                        <span className="text-sm text-gray-500 dark:text-gray-400 select-none">Status:</span>
                        {connectionState === 'connecting' && <span className="text-yellow-500 font-medium">Connecting...</span>}
                        {connectionState === 'connected' && sonioxActive && (
                            <span className="relative group cursor-default text-green-500 font-medium z-10">
                                ● Live
                                <span className="absolute top-full right-0 mt-2 px-3 py-1.5 bg-gray-800 dark:bg-gray-100 text-white dark:text-gray-900 text-xs rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none shadow-lg after:content-[''] after:absolute after:bottom-full after:right-4 after:-mb-px after:border-8 after:border-transparent after:border-b-gray-800 dark:after:border-b-gray-100">
                                    Translation streaming is live.
                                </span>
                            </span>
                        )}
                        {connectionState === 'connected' && !sonioxActive && (
                            <span className="relative group cursor-default text-yellow-500 font-medium z-10">
                                ● Stand By
                                <span className="absolute top-full right-0 mt-2 px-3 py-1.5 bg-gray-800 dark:bg-gray-100 text-white dark:text-gray-900 text-xs rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none shadow-lg after:content-[''] after:absolute after:bottom-full after:right-4 after:-mb-px after:border-8 after:border-transparent after:border-b-gray-800 dark:after:border-b-gray-100">
                                    Wait for translation streaming to be activated.
                                </span>
                            </span>
                        )}
                        {connectionState === 'error' && (
                            <span className="relative group cursor-default text-red-500 font-medium z-10">
                                Offline
                                <span className="absolute top-full right-0 mt-2 px-3 py-1.5 bg-gray-800 dark:bg-gray-100 text-white dark:text-gray-900 text-xs rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none shadow-lg after:content-[''] after:absolute after:bottom-full after:right-4 after:-mb-px after:border-8 after:border-transparent after:border-b-gray-800 dark:after:border-b-gray-100">
                                    The server is not running. Check back later!
                                </span>
                            </span>
                        )}
                    </div>
                </div>

                {/* Translation Viewer Container */}
                <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-2 sm:gap-4 min-h-0">
                    {/* Indonesian Box */}
                    <div className="hidden sm:flex flex-col min-h-0 bg-white dark:bg-gray-800 rounded-lg shadow p-4 sm:p-6 border border-gray-100 dark:border-gray-700 transition-colors duration-200">
                        <div className="text-sm font-semibold text-gray-400 dark:text-gray-500 mb-4 border-b border-gray-200 dark:border-gray-700 pb-2 text-center shrink-0 transition-colors duration-200 select-none">
                            Original
                        </div>

                        <div
                            ref={scrollRefId}
                            className={`flex-1 overflow-y-auto overflow-x-hidden leading-relaxed font-sans relative text-gray-900 dark:text-gray-100 transition-colors duration-200 ${getFontSizeClass()}`}
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
                                <div className="text-gray-400 dark:text-gray-500 italic mt-4 text-center">
                                    The original speech will appear here...
                                </div>
                            ) : (
                                <p>
                                    {spans.map((span, index) => {
                                        if (span.isLineBreak) {
                                            // Ensure we don't render multiple continuous blank blocks or first-element blank blocks
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
                                        <span className="text-gray-400 dark:text-gray-500 transition-opacity duration-200">
                                            {draftTextId}
                                        </span>
                                    )}
                                </p>
                            )}
                        </div>
                    </div>

                    {/* English Box */}
                    <div className="flex flex-col min-h-0 bg-white dark:bg-gray-800 rounded-lg shadow p-4 sm:p-6 border border-gray-100 dark:border-gray-700 transition-colors duration-200">
                        <div className="text-sm font-semibold text-gray-400 dark:text-gray-500 mb-4 border-b border-gray-200 dark:border-gray-700 pb-2 text-center shrink-0 transition-colors duration-200 select-none">
                            English
                        </div>

                        <div
                            ref={scrollRefEn}
                            onScroll={updatePopoverPosition}
                            className={`flex-1 overflow-y-auto overflow-x-hidden leading-relaxed font-sans relative text-gray-900 dark:text-gray-100 transition-colors duration-200 ${getFontSizeClass()}`}
                            style={{
                                // Dim text at the top of the scrolling viewport boundaries.
                                // The gradient opacity dynamically scales from 1.0 (no fade) to 0.3 (strong fade) based on how full the box is!
                                WebkitMaskImage: `linear-gradient(to bottom, rgba(0,0,0,${topAlpha.toFixed(2)}) 0%, rgba(0,0,0,1) 30%)`,
                                maskImage: `linear-gradient(to bottom, rgba(0,0,0,${topAlpha.toFixed(2)}) 0%, rgba(0,0,0,1) 30%)`,
                                WebkitMaskSize: '100% 100%',
                                maskSize: '100% 100%',
                                WebkitMaskRepeat: 'no-repeat',
                                maskRepeat: 'no-repeat',
                            }}
                        >
                            {spans.length === 0 && draftTextEn === '' ? (
                                <div className="text-gray-400 dark:text-gray-500 italic mt-4 text-center">
                                    Waiting for the speaker to begin...
                                </div>
                            ) : (
                                <p>
                                    {spans.map((span, index) => {
                                        if (span.isLineBreak) {
                                            // Ensure we don't render multiple continuous blank blocks or first-element blank blocks
                                            if (index === 0 || spans[index - 1]?.isLineBreak) return null;
                                            return <div key={span.id} className="h-4 sm:h-6 w-full shrink-0"></div>;
                                        }
                                        return (
                                            <span
                                                key={span.id}
                                                id={`span-${span.id}`}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    // Only show popover if there's actual Indonesian text to show
                                                    if (span.ind.trim() && span.ind !== '<end>') {
                                                        if (activePopover?.id === span.id) {
                                                            setActivePopover(null);
                                                        } else {
                                                            setActivePopover({ id: span.id, ind: span.ind });
                                                        }
                                                    }
                                                }}
                                                className={`relative transition-colors rounded ${span.ind.trim() && span.ind !== '<end>' ? 'cursor-pointer hover:bg-gray-200 dark:hover:bg-gray-600' : ''} ${activePopover?.id === span.id ? 'bg-blue-200 dark:bg-blue-800' : ''}`}
                                            >
                                                {span.en}
                                            </span>
                                        );
                                    })}
                                    {draftTextEn && (
                                        <span className="text-gray-400 dark:text-gray-500 transition-opacity duration-200">
                                            {draftTextEn}
                                        </span>
                                    )}
                                </p>
                            )}
                        </div>
                    </div>
                </div>

                {/* Fixed Overlay Popover */}
                {(function renderPopover() {
                    if (!activePopover || !popoverRect) return null;

                    const rect = popoverRect;
                    const { ind } = activePopover;
                    // Auto-flip tracking: if we're near the bottom of the screen, flip above
                    const spaceBelow = window.innerHeight - rect.bottom;
                    const isBottomHalf = spaceBelow < 150 && rect.top > 150;

                    // Exact screen dimension tracking for X clamping
                    const centerX = rect.left + rect.width / 2;
                    const popoverWidth = Math.min(window.innerWidth * 0.85, 320);

                    let leftPos = centerX - popoverWidth / 2;
                    const padding = 16;
                    // Force the box to stay fully on-screen
                    if (leftPos < padding) leftPos = padding;
                    if (leftPos + popoverWidth > window.innerWidth - padding) leftPos = window.innerWidth - popoverWidth - padding;

                    // Ensure triangle precisely targets the word center regardless of box clamp
                    const pointerLeft = centerX - leftPos;

                    return (
                        <div
                            className="fixed z-[100] p-3 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm rounded-lg shadow-2xl cursor-auto font-normal leading-snug"
                            style={{
                                width: popoverWidth,
                                left: leftPos,
                                ...(isBottomHalf ? {
                                    bottom: window.innerHeight - rect.top + 8
                                } : {
                                    top: rect.bottom + 8
                                })
                            }}
                            onClick={(e) => e.stopPropagation()}
                        >
                            <span className="block font-semibold text-gray-400 dark:text-gray-500 mb-1 text-[10px] uppercase tracking-wider">Original</span>
                            {ind}
                            <span
                                className={`absolute border-[6px] border-transparent ${isBottomHalf ? 'top-full border-t-gray-900 dark:border-t-gray-100' : 'bottom-full border-b-gray-900 dark:border-b-gray-100'}`}
                                style={{ left: Math.max(8, Math.min(pointerLeft - 6, popoverWidth - 20)) }}
                            ></span>
                        </div>
                    );
                })()}

                {/* Mobile Display Pulled-Drawer Settings Overlay */}
                {isDisplayMenuOpen && (
                    <div
                        className="sm:hidden fixed inset-x-0 bottom-16 bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 shadow-[0_-10px_20px_-5px_rgba(0,0,0,0.1)] z-30 p-5 rounded-t-2xl transition-transform"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="flex items-center justify-between mb-5">
                            <h3 className="text-sm font-bold text-gray-900 dark:text-white uppercase tracking-wider">Display Settings</h3>
                            <button onClick={() => setIsDisplayMenuOpen(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 focus:outline-none">
                                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                            </button>
                        </div>

                        <div className="mb-6">
                            <label className="text-xs text-gray-500 dark:text-gray-400 font-semibold mb-3 block">Text Size</label>
                            <div className="flex bg-gray-100 dark:bg-gray-900 rounded-lg p-1.5 h-12">
                                <button
                                    onClick={() => setFontSize('small')}
                                    className={`flex-1 flex items-center justify-center text-sm font-medium rounded-md transition-colors ${fontSize === 'small' ? 'bg-white dark:bg-gray-700 shadow text-gray-900 dark:text-white' : 'text-gray-500 dark:text-gray-400'}`}
                                >
                                    Smaller
                                </button>
                                <button
                                    onClick={() => setFontSize('regular')}
                                    className={`flex-1 flex items-center justify-center text-sm font-medium rounded-md transition-colors ${fontSize === 'regular' ? 'bg-white dark:bg-gray-700 shadow text-gray-900 dark:text-white' : 'text-gray-500 dark:text-gray-400'}`}
                                >
                                    Regular
                                </button>
                                <button
                                    onClick={() => setFontSize('large')}
                                    className={`flex-1 flex items-center justify-center text-sm font-medium rounded-md transition-colors ${fontSize === 'large' ? 'bg-white dark:bg-gray-700 shadow text-gray-900 dark:text-white' : 'text-gray-500 dark:text-gray-400'}`}
                                >
                                    Larger
                                </button>
                            </div>
                        </div>

                        <div className="mb-5">
                            <label className="text-xs text-gray-500 dark:text-gray-400 font-semibold mb-3 block">Voice Volume</label>
                            <input
                                type="range" min="0" max="1" step="0.1"
                                value={ttsVolume}
                                onChange={(e) => setTtsVolume(parseFloat(e.target.value))}
                                className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer dark:bg-gray-700 accent-blue-500"
                            />
                        </div>

                        {voices.length > 0 && (
                            <div className="mb-6">
                                <label className="text-xs text-gray-500 dark:text-gray-400 font-semibold mb-3 block">Voice Selection</label>
                                <select
                                    value={selectedVoiceURI}
                                    onChange={(e) => setSelectedVoiceURI(e.target.value)}
                                    className="w-full bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-600 text-gray-900 dark:text-white text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block p-2.5"
                                >
                                    {voices.filter(v => v.lang.startsWith('en') || v.lang.startsWith('id')).map(voice => (
                                        <option key={voice.voiceURI} value={voice.voiceURI}>
                                            {voice.name}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        )}

                        <div className="flex items-center justify-between py-2 border-t border-gray-100 dark:border-gray-700 pt-5">
                            <div className="flex items-center space-x-3">
                                {isDarkMode ? (
                                    <svg className="w-6 h-6 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" /></svg>
                                ) : (
                                    <svg className="w-6 h-6 text-yellow-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" /></svg>
                                )}
                                <span className="text-base font-medium text-gray-900 dark:text-white">Dark Mode</span>
                            </div>
                            <button
                                onClick={() => setIsDarkMode(!isDarkMode)}
                                className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors ${isDarkMode ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
                            >
                                <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${isDarkMode ? 'translate-x-6' : 'translate-x-1'}`} />
                            </button>
                        </div>
                    </div>
                )}

                {/* Mobile Bottom Navigation Bar */}
                <div className="sm:hidden shrink-0 h-16 bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 flex justify-around items-center shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)] z-40 transition-colors duration-200 relative">
                    <button
                        onClick={(e) => { e.stopPropagation(); setIsTtsEnabled(!isTtsEnabled); }}
                        className={`p-2 flex flex-col items-center justify-center focus:outline-none transition-colors ${isTtsEnabled ? 'text-blue-500' : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100'}`}
                    >
                        <svg className="w-6 h-6 mb-1" fill="none" viewBox="-2 -2 28 28" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12V9a9 9 0 00-18 0v3m0 0a3 3 0 00-3 3v2a3 3 0 003 3h2a1 1 0 001-1v-6a1 1 0 00-1-1H3m18 0a3 3 0 013 3v2a3 3 0 01-3 3h-2a1 1 0 01-1-1v-6a1 1 0 011-1h2z" /></svg>
                        <span className="text-xs font-medium">Listen</span>
                    </button>
                    <button
                        onClick={(e) => { e.stopPropagation(); setIsDisplayMenuOpen(!isDisplayMenuOpen); }}
                        className={`p-2 flex flex-col items-center justify-center focus:outline-none transition-colors ${isDisplayMenuOpen ? 'text-blue-500' : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100'}`}
                    >
                        <svg className="w-6 h-6 mb-1" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                        <span className="text-xs font-medium">Options</span>
                    </button>
                    <button disabled className="p-2 flex flex-col items-center justify-center text-gray-400 dark:text-gray-500 focus:outline-none transition-colors opacity-50 cursor-not-allowed">
                        <svg className="w-6 h-6 mb-1" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
                        <span className="text-xs font-medium">You</span>
                    </button>
                </div>

            </div>
        </div>
    );
}
