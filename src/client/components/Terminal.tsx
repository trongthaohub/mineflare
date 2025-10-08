
import { For, useLiveSignal } from "@preact/signals/utils";
import { signal } from "@preact/signals-core";
import { Elysia, t } from "elysia";
import { treaty } from "@elysiajs/eden";
import { useEffect, useMemo, useState, useRef, useCallback } from 'preact/hooks';
import { useSignal } from "@preact/signals";
import { apiHost, fetchApi } from "../utils/api";

// This exists for the sake of getting the type of the app
const fakeApp = () => new Elysia()
    .ws("/ws", {
        body: t.String(),
        response: t.String(),
        message(ws, message) {
            ws.send(message);
        },
    })
type App = ReturnType<typeof fakeApp>;

function useApp() {

    const api = useMemo(() => {
        return treaty<App>(apiHost());
    }, []);
    return api;
}

const history = signal([] as Array<string>);

type ServerState = 'stopped' | 'starting' | 'running' | 'stopping';

interface TerminalProps {
    serverState: ServerState;
}

export function Terminal({ serverState }: TerminalProps) {

    const [historyLength, setHistoryLength] = useState(history.value.length);
    const [command, setCommand] = useState('');
    const [chatError, setChatError] = useState('');
    const [hoveredSendButton, setHoveredSendButton] = useState(false);
    const historyEndRef = useRef<HTMLDivElement>(null);
    const chatRef = useRef<any>(null);
    const pendingMessagesRef = useRef<string[]>([]);
    const reconnectTimerRef = useRef<number | null>(null);
    const isReconnectingRef = useRef(false);

    const api = useApp();

    const connectWebSocket = useCallback(async () => {
        try {
            // Fetch a WebSocket token before connecting
            const tokenResponse = await fetchApi('/api/auth/ws-token');
            if (!tokenResponse.ok) {
                console.error("Failed to get WebSocket token, status:", tokenResponse.status);
                setChatError("Authentication failed. Please refresh the page.");
                return null;
            }
            
            const { token } = await tokenResponse.json() as { token: string };
            
            // Connect with token in URL
            const chat = api.ws.subscribe({
                query: { token }
            });
            chatRef.current = chat;

            chat.subscribe((message) => {
                console.log("got", message);
                const messageText = message.data as unknown as string;
                console.log("Raw message:", messageText);
                console.log("Has § character:", messageText.includes('§'));
                history.value.push(messageText)
                setHistoryLength(history.value.length);
            });

            chat.on("open", () => {
                console.log("WebSocket connected");
                setChatError('');
                
                // Stop reconnection attempts
                if (reconnectTimerRef.current) {
                    clearInterval(reconnectTimerRef.current);
                    reconnectTimerRef.current = null;
                }
                isReconnectingRef.current = false;
                
                // Send pending messages first
                if (pendingMessagesRef.current.length > 0) {
                    console.log("Sending pending messages:", pendingMessagesRef.current);
                    for (const msg of pendingMessagesRef.current) {
                        try {
                            chat.send(msg);
                        } catch (err) {
                            console.error("Failed to send pending message:", err);
                        }
                    }
                    pendingMessagesRef.current = [];
                }
                
                // Then send initial list command
                chat.send("list");
            });

            chat.on("error", (err: any) => {
                console.error("WebSocket error:", err);
                const errString = stringifyError(err);
                setChatError("Connection error: " + errString);
                
                // If it's a 401 error, reload to re-authenticate
                if (errString.includes('401') || errString.toLowerCase().includes('unauthorized')) {
                    console.log('WebSocket 401 error, reloading page to re-authenticate...');
                    window.location.reload();
                }
            });

            chat.on("close", (event: any) => {
                console.log("WebSocket closed", event);
                
                // Check if close was due to 401 Unauthorized
                if (event?.code === 1008 || event?.reason?.includes('401') || event?.reason?.toLowerCase().includes('unauthorized')) {
                    console.log('WebSocket closed with 401, reloading page to re-authenticate...');
                    window.location.reload();
                } else {
                    chatRef.current = null;
                }
            });

            return chat;
        } catch (err) {
            console.error("Failed to create WebSocket:", err);
            setChatError(new Date().toISOString() + " " + stringifyError(err));
            return null;
        }
    }, [api]);

    const startReconnectTimer = useCallback(() => {
        if (isReconnectingRef.current || serverState !== 'running') {
            return;
        }

        isReconnectingRef.current = true;
        console.log("Starting reconnection timer...");

        const attemptReconnect = () => {
            if (serverState !== 'running') {
                console.log("Server not running, stopping reconnect attempts");
                if (reconnectTimerRef.current) {
                    clearInterval(reconnectTimerRef.current);
                    reconnectTimerRef.current = null;
                }
                isReconnectingRef.current = false;
                return;
            }

            console.log("Attempting to reconnect WebSocket...");
            
            // Close existing connection if any
            if (chatRef.current) {
                try {
                    chatRef.current.close();
                } catch (err) {
                    console.error("Error closing old connection:", err);
                }
                chatRef.current = null;
            }

            // Try to establish new connection
            connectWebSocket();
        };

        // Try immediately, then every 5 seconds
        attemptReconnect();
        reconnectTimerRef.current = window.setInterval(attemptReconnect, 5000);
    }, [serverState, connectWebSocket]);

    useEffect(() => {
        // Only connect WebSocket when server is running
        if (serverState === 'running') {
            connectWebSocket();

            return () => {
                // Clear reconnect timer
                if (reconnectTimerRef.current) {
                    clearInterval(reconnectTimerRef.current);
                    reconnectTimerRef.current = null;
                }
                isReconnectingRef.current = false;

                // Close WebSocket
                if (chatRef.current) {
                    chatRef.current.close();
                    chatRef.current = null;
                }
            };
        } else {
            // Disconnect WebSocket if server is not running
            if (reconnectTimerRef.current) {
                clearInterval(reconnectTimerRef.current);
                reconnectTimerRef.current = null;
            }
            isReconnectingRef.current = false;
            pendingMessagesRef.current = [];

            if (chatRef.current) {
                chatRef.current.close();
                chatRef.current = null;
            }
        }
    }, [serverState, connectWebSocket])

    // Auto-scroll to bottom when history updates
    useEffect(() => {
        historyEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, [historyLength]);

    const sendCommand = () => {
        if (!command.trim() || serverState !== 'running') return; // Don't send empty commands or when server isn't running
        
        const messageToSend = command;
        
        // Add command to history with $ prefix
        history.value.push(`$ ${messageToSend}`);
        setHistoryLength(history.value.length);
        setCommand('');
        
        // Try to send the message
        if (chatRef.current) {
            try {
                chatRef.current.send(messageToSend);
            } catch (err) {
                console.error("Failed to send message:", err);
                setChatError("Connection lost. Reconnecting...");
                
                // Add to pending messages
                if (!pendingMessagesRef.current.includes(messageToSend)) {
                    pendingMessagesRef.current.push(messageToSend);
                }
                
                // Start reconnection attempts
                startReconnectTimer();
            }
        } else {
            // No connection, add to pending and start reconnecting
            console.log("No WebSocket connection, queueing message");
            setChatError("Not connected. Reconnecting...");
            
            if (!pendingMessagesRef.current.includes(messageToSend)) {
                pendingMessagesRef.current.push(messageToSend);
            }
            
            startReconnectTimer();
        }
    }
    
    const canSendCommands = serverState === 'running';

	return (
		<div style={{
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            minHeight: '400px',
            maxHeight: '500px',
            background: 'rgba(26, 46, 30, 0.4)',
            backdropFilter: 'blur(10px)',
            border: '1px solid rgba(87, 166, 78, 0.2)',
            borderRadius: '16px',
            overflow: 'hidden',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.3)',
        }}>
            {/* Terminal Header */}
            <div style={{
                padding: '16px 20px',
                background: 'rgba(0, 0, 0, 0.3)',
                borderBottom: '1px solid rgba(87, 166, 78, 0.2)',
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
            }}>
                <div style={{
                    width: '40px',
                    height: '40px',
                    borderRadius: '10px',
                    background: 'linear-gradient(135deg, #57A64E 0%, #6BB854 100%)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '1.25rem',
                }}>
                    💻
                </div>
                <div>
                    <div style={{
                        fontSize: '1.125rem',
                        fontWeight: '700',
                        color: '#fff',
                        marginBottom: '2px',
                    }}>
                        Server Console
                    </div>
                    <div style={{
                        fontSize: '0.75rem',
                        color: '#888',
                        fontFamily: 'ui-monospace, monospace',
                    }}>
                        RCON Terminal
                    </div>
                </div>
            </div>

            {/* Terminal output area */}
            <div style={{
                flex: 1,
                overflowY: 'auto',
                padding: '20px',
                fontFamily: 'ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, Consolas, "DejaVu Sans Mono", monospace',
                fontSize: '13px',
                lineHeight: '1.6',
                color: '#d4d4d4',
                background: 'rgba(0, 0, 0, 0.2)',
            }}>
                <For each={history} fallback={
                    <pre style={{ 
                        margin: 0, 
                        color: '#888',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                    }}>
                        <span style={{ color: '#57A64E' }}>➜</span> Waiting for commands...
                    </pre>
                }>
                    {(item, index) => {
                        const isCommand = item.startsWith('$');
                        const displayText = isCommand ? item : item;
                        
                        return (
                            <pre 
                                hidden={index > historyLength} 
                                key={index}
                                style={{ 
                                    margin: '0 0 10px 0',
                                    whiteSpace: 'pre-wrap',
                                    wordBreak: 'break-word',
                                    color: isCommand ? '#FFB600' : '#b0e0b0',
                                    padding: '6px 0',
                                    borderLeft: isCommand ? '3px solid #FFB600' : '3px solid transparent',
                                    paddingLeft: '12px',
                                }}
                            >
                                {isCommand ? displayText : renderMinecraftText(displayText)}
                            </pre>
                        );
                    }}
                </For>
                <div ref={historyEndRef} />
            </div>

            {/* Error display */}
            {chatError && (
                <div style={{
                    padding: '12px 20px',
                    backgroundColor: 'rgba(255, 107, 107, 0.15)',
                    color: '#ff6b6b',
                    fontSize: '13px',
                    fontFamily: 'monospace',
                    borderTop: '1px solid rgba(255, 107, 107, 0.3)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                }}>
                    <span>⚠️</span>
                    {chatError}
                </div>
            )}

            {/* Input area */}
            <div style={{
                display: 'flex',
                gap: '10px',
                padding: '16px 20px',
                background: 'rgba(0, 0, 0, 0.3)',
                borderTop: '1px solid rgba(87, 166, 78, 0.2)',
            }}>
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    color: '#57A64E',
                    fontSize: '1.25rem',
                    fontWeight: '700',
                    marginRight: '4px',
                }}>
                    ➜
                </div>
                <input 
                    type="text" 
                    value={command} 
                    onInput={(e) => setCommand(e.currentTarget.value)} 
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            sendCommand();
                        }
                    }}
                    disabled={!canSendCommands}
                    autocomplete="off"
                    autocorrect="off"
                    autocapitalize="off"
                    spellcheck={false}
                    placeholder={canSendCommands ? "Type a command..." : "Start the server to send commands"}
                    style={{
                        flex: 1,
                        padding: '10px 14px',
                        background: canSendCommands ? 'rgba(0, 0, 0, 0.4)' : 'rgba(0, 0, 0, 0.2)',
                        border: '1px solid rgba(87, 166, 78, 0.3)',
                        borderRadius: '8px',
                        color: canSendCommands ? '#e0e0e0' : '#666',
                        fontFamily: 'ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, Consolas, "DejaVu Sans Mono", monospace',
                        fontSize: '14px',
                        outline: 'none',
                        transition: 'all 0.2s ease',
                        cursor: canSendCommands ? 'text' : 'not-allowed',
                        opacity: canSendCommands ? 1 : 0.6,
                    }}
                    onFocus={(e) => {
                        if (canSendCommands) {
                            e.currentTarget.style.borderColor = 'rgba(87, 166, 78, 0.6)';
                            e.currentTarget.style.background = 'rgba(0, 0, 0, 0.5)';
                        }
                    }}
                    onBlur={(e) => {
                        if (canSendCommands) {
                            e.currentTarget.style.borderColor = 'rgba(87, 166, 78, 0.3)';
                            e.currentTarget.style.background = 'rgba(0, 0, 0, 0.4)';
                        }
                    }}
                />
                <div style={{ position: 'relative' }}>
                    <button 
                        onClick={() => sendCommand()}
                        disabled={!canSendCommands}
                        style={{
                            padding: '10px 24px',
                            background: canSendCommands 
                                ? 'linear-gradient(135deg, #57A64E 0%, #6BB854 100%)' 
                                : 'rgba(87, 166, 78, 0.2)',
                            border: 'none',
                            borderRadius: '8px',
                            color: canSendCommands ? 'white' : '#666',
                            fontWeight: '600',
                            cursor: canSendCommands ? 'pointer' : 'not-allowed',
                            fontSize: '14px',
                            transition: 'all 0.2s ease',
                            boxShadow: canSendCommands ? '0 4px 12px rgba(87, 166, 78, 0.3)' : 'none',
                            opacity: canSendCommands ? 1 : 0.5,
                        }}
                        onMouseEnter={(e) => {
                            setHoveredSendButton(true);
                            if (canSendCommands) {
                                e.currentTarget.style.transform = 'translateY(-2px)';
                                e.currentTarget.style.boxShadow = '0 6px 20px rgba(87, 166, 78, 0.4)';
                            }
                        }}
                        onMouseLeave={(e) => {
                            setHoveredSendButton(false);
                            if (canSendCommands) {
                                e.currentTarget.style.transform = 'translateY(0)';
                                e.currentTarget.style.boxShadow = '0 4px 12px rgba(87, 166, 78, 0.3)';
                            }
                        }}
                    >
                        Send
                    </button>
                    
                    {/* Tooltip for disabled state */}
                    {hoveredSendButton && !canSendCommands && (
                        <div style={{
                            position: 'absolute',
                            bottom: '100%',
                            right: '0',
                            marginBottom: '8px',
                            padding: '8px 12px',
                            background: 'rgba(0, 0, 0, 0.95)',
                            border: '1px solid rgba(87, 166, 78, 0.3)',
                            borderRadius: '8px',
                            color: '#b0b0b0',
                            fontSize: '0.75rem',
                            whiteSpace: 'nowrap',
                            zIndex: 1000,
                            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.5)',
                            pointerEvents: 'none',
                        }}>
                            Start the server to send commands
                        </div>
                    )}
                </div>
            </div>
		</div>
	);
}

function stringifyError(err: unknown): string {
    if (err instanceof Error) {
        return err.message;
    }
    return String(err);
}

// Minecraft color code mappings
const COLOR_MAP: Record<string, string> = {
    '0': '#000000', // Black
    '1': '#0000AA', // Dark Blue
    '2': '#00AA00', // Dark Green
    '3': '#00AAAA', // Dark Aqua
    '4': '#AA0000', // Dark Red
    '5': '#AA00AA', // Dark Purple
    '6': '#FFAA00', // Gold
    '7': '#AAAAAA', // Gray
    '8': '#555555', // Dark Gray
    '9': '#5555FF', // Blue
    'a': '#55FF55', // Green
    'b': '#55FFFF', // Aqua
    'c': '#FF5555', // Red
    'd': '#FF55FF', // Light Purple
    'e': '#FFFF55', // Yellow
    'f': '#FFFFFF', // White
    'r': 'reset',   // Reset
};

const STYLE_MAP: Record<string, string> = {
    'l': 'font-weight: bold',
    'm': 'text-decoration: line-through',
    'n': 'text-decoration: underline',
    'o': 'font-style: italic',
};

interface TextSegment {
    text: string;
    color?: string;
    styles: string[];
}

// Parse Minecraft formatting codes (§ followed by a character)
function parseMinecraftText(text: string): TextSegment[] {
    const segments: TextSegment[] = [];
    let currentColor: string | undefined = undefined;
    let currentStyles: string[] = [];
    let currentText = '';
    
    for (let i = 0; i < text.length; i++) {
        // Check for formatting code (§ or Section sign)
        if (text[i] === '§' && i + 1 < text.length) {
            // Save current segment if it has text
            if (currentText) {
                segments.push({
                    text: currentText,
                    color: currentColor,
                    styles: [...currentStyles],
                });
                currentText = '';
            }
            
            const code = text[i + 1].toLowerCase();
            
            // Check if it's a color code
            if (COLOR_MAP[code]) {
                if (COLOR_MAP[code] === 'reset') {
                    currentColor = undefined;
                    currentStyles = [];
                } else {
                    currentColor = COLOR_MAP[code];
                    // Color codes reset formatting in Minecraft
                    currentStyles = [];
                }
            }
            // Check if it's a style code
            else if (STYLE_MAP[code]) {
                currentStyles.push(STYLE_MAP[code]);
            }
            
            // Skip the § and the code character
            i++;
        } else {
            currentText += text[i];
        }
    }
    
    // Add final segment
    if (currentText) {
        segments.push({
            text: currentText,
            color: currentColor,
            styles: [...currentStyles],
        });
    }
    
    return segments;
}

// Render parsed segments as JSX
function renderMinecraftText(text: string) {
    const segments = parseMinecraftText(text);
    
    // Debug logging
    if (text.includes('§')) {
        console.log("Parsing text with § codes:", text);
        console.log("Segments:", segments);
    }
    
    return segments.map((segment, index) => {
        const styleObj: Record<string, string> = {};
        
        if (segment.color) {
            styleObj.color = segment.color;
        }
        
        // Apply styles from the styles array
        segment.styles.forEach(styleStr => {
            const [prop, value] = styleStr.split(':').map(s => s.trim());
            if (prop && value) {
                // Convert CSS property names from kebab-case to camelCase
                const camelProp = prop.replace(/-([a-z])/g, (g) => g[1].toUpperCase());
                styleObj[camelProp] = value;
            }
        });
        
        return (
            <span key={index} style={styleObj}>
                {segment.text}
            </span>
        );
    });
}