import { useState, useEffect, useRef } from 'react';
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

export default function App() {
    const [sessionToken, setSessionToken] = useState<string | null>(null);
    const [connectionState, setConnectionState] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle');
    const [errorMsg, setErrorMsg] = useState('');
    const [isValidating, setIsValidating] = useState(false);
    const [sonioxActive, setSonioxActive] = useState(false);

    // Desktop left panel Indonesian stream
    const [finalTextId, setFinalTextId] = useState('');
    const [draftTextId, setDraftTextId] = useState('');

    // Dynamic Popover English stream
    const [spans, setSpans] = useState<TextSpan[]>([]);
    const [draftTextEn, setDraftTextEn] = useState('');
    const [activePopover, setActivePopover] = useState<{ id: string; ind: string; } | null>(null);
    const [popoverRect, setPopoverRect] = useState<DOMRect | null>(null);

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
    }, [spans, draftTextEn, finalTextId, draftTextId]);

    const updatePopoverPosition = () => {
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

    useEffect(() => {
        if (!sessionToken) return;

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

                    payload.tokens.forEach((token: any) => {
                        // Per user request, STRICT routing based on Soniox doc status
                        const isTranslation = token.translation_status === 'translation';

                        // Handle <end> marker spacing explicitly as a layout block rather than \n text
                        // This prevents highlight bugs and popovers attaching to invisible space
                        if (token.text === '<end>') {
                            if (token.is_final) {
                                // Flush anything currently in the buffer before adding the break
                                if (pendingIndRef.current.trim() || incomingSpans.length > 0) {
                                    // Not creating an empty word span here, just adding the break
                                }
                                incomingSpans.push({ id: generateId(), en: '', ind: '', isLineBreak: true });
                            }
                            return; // Skip normal text processing for <end>
                        }

                        if (token.is_final) {
                            if (isTranslation) {
                                // Final Translation Token (English Box)
                                // If there is NO pending Indonesian context for this specific English word,
                                // the user requested we MUST NOT append it to the prior span. We must create a new one.
                                incomingSpans.push({
                                    id: generateId(),
                                    en: token.text,
                                    ind: pendingIndRef.current // Attached to whatever is buffered, or empty string
                                });
                                // Clear the attached context so the next English word doesn't steal it
                                pendingIndRef.current = '';
                            } else {
                                // Final Original Token (Indonesian Box)
                                newFinalId += token.text;
                                pendingIndRef.current += token.text;
                            }
                        } else {
                            if (isTranslation) newDraftEn += token.text;
                            else newDraftId += token.text;
                        }
                    });

                    // Update UI states
                    if (newFinalId) {
                        setFinalTextId(prev => prev + newFinalId);
                    }
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
        };
    }, [sessionToken, reconnectTrigger]);

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
            onClick={() => setActivePopover(null)}
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
                    <div className="flex items-center space-x-2 whitespace-nowrap">
                        <span className="text-sm text-gray-500 dark:text-gray-400">Status:</span>
                        {connectionState === 'connecting' && <span className="text-yellow-500 font-medium">Connecting...</span>}
                        {connectionState === 'connected' && sonioxActive && (
                            <span className="relative group cursor-default text-green-500 font-medium">
                                ● Live
                                <span className="absolute bottom-full right-0 mb-2 px-3 py-1.5 bg-gray-800 text-white text-xs rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none shadow-lg">
                                    Translation streaming is live.
                                </span>
                            </span>
                        )}
                        {connectionState === 'connected' && !sonioxActive && (
                            <span className="relative group cursor-default text-yellow-500 font-medium">
                                ● Stand By
                                <span className="absolute bottom-full right-0 mb-2 px-3 py-1.5 bg-gray-800 text-white text-xs rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none shadow-lg">
                                    Wait for translation streaming to be activated.
                                </span>
                            </span>
                        )}
                        {connectionState === 'error' && (
                            <span className="relative group cursor-default text-red-500 font-medium">
                                Offline
                                <span className="absolute bottom-full right-0 mb-2 px-3 py-1.5 bg-gray-800 text-white text-xs rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none shadow-lg">
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
                        <div className="text-sm font-semibold text-gray-400 dark:text-gray-500 mb-4 border-b border-gray-200 dark:border-gray-700 pb-2 text-center shrink-0 transition-colors duration-200">
                            Indonesian
                        </div>

                        <div
                            ref={scrollRefId}
                            className="flex-1 overflow-y-auto text-xl leading-relaxed font-sans"
                        >
                            {finalTextId === '' && draftTextId === '' ? (
                                <div className="text-gray-400 dark:text-gray-500 italic mt-4 text-center">
                                    The original Indonesian speech will appear here...
                                </div>
                            ) : (
                                <p>
                                    <span className="text-gray-900 dark:text-gray-100">{finalTextId}</span>
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
                        <div className="text-sm font-semibold text-gray-400 dark:text-gray-500 mb-4 border-b border-gray-200 dark:border-gray-700 pb-2 text-center shrink-0 transition-colors duration-200">
                            English
                        </div>

                        <div
                            ref={scrollRefEn}
                            onScroll={updatePopoverPosition}
                            className="flex-1 overflow-y-auto overflow-x-hidden text-xl leading-relaxed font-sans relative text-gray-900 dark:text-gray-100 transition-colors duration-200"
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

                {/* Mobile Bottom Navigation Bar */}
                <div className="sm:hidden shrink-0 h-16 bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 flex justify-around items-center shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)] z-40 transition-colors duration-200">
                    <button
                        onClick={(e) => { e.stopPropagation(); setIsDarkMode(!isDarkMode); }}
                        className={`p-2 flex flex-col items-center justify-center focus:outline-none transition-colors ${isDarkMode ? 'text-blue-500' : 'text-gray-500 dark:text-gray-400 hover:text-gray-900'}`}
                    >
                        <svg className="w-6 h-6 mb-1" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" /></svg>
                        <span className="text-[10px] uppercase font-bold tracking-wider">Dark</span>
                    </button>
                    <button className="p-2 flex flex-col items-center justify-center text-blue-500 focus:outline-none transition-colors">
                        <svg className="w-6 h-6 mb-1" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129" /></svg>
                        <span className="text-[10px] uppercase font-bold tracking-wider">Live</span>
                    </button>
                    <button className="p-2 flex flex-col items-center justify-center text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 focus:outline-none transition-colors">
                        <svg className="w-6 h-6 mb-1" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16m-7 6h7" /></svg>
                        <span className="text-[10px] uppercase font-bold tracking-wider">Menu</span>
                    </button>
                </div>

            </div>
        </div>
    );
}
