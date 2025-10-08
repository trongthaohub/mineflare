import { useEffect, useState, useRef } from 'preact/hooks';

interface Props {
  serverState?: 'stopped' | 'starting' | 'running' | 'stopping';
}

interface SessionData {
  isRunning: boolean;
  startedAt?: number;
  stoppedAt?: number;
  durationMs?: number;
  stats?: {
    thisMonth: number;
    thisYear: number;
  };
}

function formatElapsedTime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  const h = hours.toString().padStart(2, '0');
  const m = (minutes % 60).toString().padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');

  return `${h}:${m}:${s}`;
}

function formatTimeAgo(ms: number): string {
  if (!ms) return 'Never started';

  const now = Date.now();
  const diff = now - ms;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);

  if (seconds < 60) return 'moments ago';
  if (minutes < 2) return 'about a minute ago';
  if (minutes < 60) return `about ${minutes} minutes ago`;
  if (hours < 2) return 'about an hour ago';
  if (hours < 24) return `about ${hours} hours ago`;
  if (days < 2) return 'about a day ago';
  if (days < 7) return `about ${days} days ago`;
  if (weeks < 2) return 'about a week ago';
  if (weeks < 4) return `about ${weeks} weeks ago`;
  if (months < 2) return 'about a month ago';
  return `about ${months} months ago`;
}

function formatHours(hours: number): string {
  if (hours < 0.017) return '< 1m'; // Less than 1 minute
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  const days = Math.floor(hours / 24);
  const remainingHours = Math.round(hours % 24);
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
}

export function SessionTimer({ serverState }: Props) {
  const [sessionData, setSessionData] = useState<SessionData | null>(null);
  const [currentTime, setCurrentTime] = useState(Date.now());
  const [loading, setLoading] = useState(true);
  const prevServerStateRef = useRef<string | undefined>(serverState);

  // Fetch session data
  useEffect(() => {
    const fetchSessionData = async () => {
      try {
        const [currentRes, lastRes, statsRes] = await Promise.all([
          fetch('/api/session/current'),
          fetch('/api/session/last'),
          fetch('/api/session/stats')
        ]);

        const current = await currentRes.json() as { isRunning: boolean; startedAt?: number };
        const last = await lastRes.json() as { stoppedAt?: number; durationMs?: number };
        const stats = await statsRes.json() as { thisMonth: number; thisYear: number };

        setSessionData({
          isRunning: current.isRunning,
          startedAt: current.startedAt,
          stoppedAt: last.stoppedAt,
          durationMs: last.durationMs,
          stats
        });
        setLoading(false);
      } catch (error) {
        console.error('Failed to fetch session data:', error);
        setLoading(false);
      }
    };

    // Detect state transitions
    const prevState = prevServerStateRef.current;
    const transitionedToStopped = prevState !== 'stopped' && serverState === 'stopped';
    const transitionedToRunning = prevState !== 'running' && serverState === 'running';
    
    let delayTimeout: number | null = null;
    
    // Fetch immediately on mount or when transitioning to stopped/running
    if (!prevState || transitionedToRunning) {
      fetchSessionData();
    } else if (transitionedToStopped) {
      // Add a small delay when transitioning to stopped to ensure DB is updated
      delayTimeout = setTimeout(fetchSessionData, 500) as unknown as number;
    }
    
    prevServerStateRef.current = serverState;

    // Refetch every 30 seconds
    const interval = setInterval(fetchSessionData, 30000);
    
    return () => {
      clearInterval(interval);
      if (delayTimeout !== null) {
        clearTimeout(delayTimeout);
      }
    };
  }, [serverState]);

  // Update current time every second for live timer
  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(Date.now());
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div style={{
        background: 'rgba(26, 46, 30, 0.4)',
        backdropFilter: 'blur(10px)',
        border: '1px solid rgba(91, 155, 213, 0.2)',
        borderRadius: '16px',
        padding: '32px',
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.3)',
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#888',
          fontSize: '1rem',
        }}>
          <span style={{ marginRight: '10px', fontSize: '1.5rem' }}>⏳</span>
          Loading session data...
        </div>
      </div>
    );
  }

  const isRunning = serverState === 'running' && sessionData?.isRunning;
  const elapsedMs = isRunning && sessionData?.startedAt
    ? currentTime - sessionData.startedAt
    : 0;
  const formattedTime = isRunning ? formatElapsedTime(elapsedMs) : '00:00:00';
  const lastStopped = sessionData?.stoppedAt ? formatTimeAgo(sessionData.stoppedAt) : 'Never started';

  return (
    <div style={{
      background: 'rgba(26, 46, 30, 0.4)',
      backdropFilter: 'blur(10px)',
      border: `1px solid ${isRunning ? 'rgba(85, 255, 85, 0.2)' : 'rgba(91, 155, 213, 0.2)'}`,
      borderRadius: '16px',
      padding: '32px',
      boxShadow: '0 8px 32px rgba(0, 0, 0, 0.3)',
      transition: 'all 0.3s ease',
    }}
    onMouseEnter={(e) => {
      e.currentTarget.style.borderColor = isRunning ? 'rgba(85, 255, 85, 0.4)' : 'rgba(91, 155, 213, 0.4)';
      e.currentTarget.style.transform = 'translateY(-4px)';
      e.currentTarget.style.boxShadow = '0 12px 40px rgba(0, 0, 0, 0.4)';
    }}
    onMouseLeave={(e) => {
      e.currentTarget.style.borderColor = isRunning ? 'rgba(85, 255, 85, 0.2)' : 'rgba(91, 155, 213, 0.2)';
      e.currentTarget.style.transform = 'translateY(0)';
      e.currentTarget.style.boxShadow = '0 8px 32px rgba(0, 0, 0, 0.3)';
    }}
    >
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        marginBottom: '24px',
      }}>
        <div style={{
          width: '48px',
          height: '48px',
          borderRadius: '12px',
          background: isRunning
            ? 'linear-gradient(135deg, #55FF55 0%, #57A64E 100%)'
            : 'linear-gradient(135deg, #5B9BD5 0%, #4A7BA7 100%)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '1.5rem',
          marginRight: '16px',
          boxShadow: isRunning
            ? '0 4px 12px rgba(85, 255, 85, 0.3)'
            : '0 4px 12px rgba(91, 155, 213, 0.3)',
        }}>
          {isRunning ? '▶' : '⏱'}
        </div>
        <div>
          <h2 style={{
            margin: '0 0 4px 0',
            fontSize: '1.5rem',
            fontWeight: '700',
            color: '#fff',
          }}>
            Session Timer
          </h2>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}>
            <div style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              backgroundColor: isRunning ? '#55FF55' : '#5B9BD5',
              boxShadow: isRunning
                ? '0 0 8px #55FF55'
                : '0 0 8px #5B9BD5',
              animation: isRunning ? 'pulse 2s ease-in-out infinite' : 'none',
            }} />
            <span style={{
              color: isRunning ? '#55FF55' : '#5B9BD5',
              fontWeight: '600',
              fontSize: '0.875rem',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}>
              {isRunning ? 'Running' : 'Stopped'}
            </span>
          </div>
        </div>
      </div>

      {/* Timer Display */}
      <div style={{
        background: isRunning
          ? 'rgba(85, 255, 85, 0.1)'
          : 'rgba(91, 155, 213, 0.1)',
        border: `1px solid ${isRunning ? 'rgba(85, 255, 85, 0.2)' : 'rgba(91, 155, 213, 0.2)'}`,
        borderRadius: '12px',
        padding: '24px',
        marginBottom: '16px',
        textAlign: 'center',
      }}>
        <div style={{
          fontSize: '0.75rem',
          color: '#888',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          marginBottom: '12px',
          fontWeight: '600',
        }}>
          {isRunning ? '⏱ Current Session' : '🕐 Last Stopped'}
        </div>
        <div style={{
          fontSize: isRunning ? '3rem' : '1.5rem',
          fontWeight: '700',
          color: isRunning ? '#55FF55' : '#888',
          fontFamily: 'monospace',
          letterSpacing: isRunning ? '0.1em' : '0',
          textShadow: isRunning ? '0 0 20px rgba(85, 255, 85, 0.3)' : 'none',
        }}>
          {isRunning ? formattedTime : lastStopped}
        </div>
      </div>

      {/* Usage Stats */}
      {sessionData?.stats && (
        <div style={{
          display: 'grid',
          gap: '12px',
        }}>
          <div style={{
            fontSize: '0.75rem',
            color: '#888',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            fontWeight: '600',
            marginTop: '8px',
          }}>
            📊 Usage Statistics
          </div>

          <div style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '12px',
          }}>
            {/* This Month */}
            <div style={{
              background: 'rgba(255, 182, 0, 0.1)',
              border: '1px solid rgba(255, 182, 0, 0.2)',
              borderRadius: '10px',
              padding: '16px',
              textAlign: 'center',
            }}>
              <div style={{
                fontSize: '0.7rem',
                color: '#888',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                marginBottom: '8px',
                fontWeight: '600',
              }}>
                This Month
              </div>
              <div style={{
                fontSize: '1.5rem',
                fontWeight: '700',
                color: '#FFB600',
              }}>
                {formatHours(sessionData.stats.thisMonth)}
              </div>
            </div>

            {/* This Year */}
            <div style={{
              background: 'rgba(91, 155, 213, 0.1)',
              border: '1px solid rgba(91, 155, 213, 0.2)',
              borderRadius: '10px',
              padding: '16px',
              textAlign: 'center',
            }}>
              <div style={{
                fontSize: '0.7rem',
                color: '#888',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                marginBottom: '8px',
                fontWeight: '600',
              }}>
                This Year
              </div>
              <div style={{
                fontSize: '1.5rem',
                fontWeight: '700',
                color: '#5B9BD5',
              }}>
                {formatHours(sessionData.stats.thisYear)}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
