import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { fetchApi } from '../utils/api';

interface MinimapProps {
  serverState: 'stopped' | 'starting' | 'running' | 'stopping';
}

export function Minimap({ serverState }: MinimapProps) {
  const [dynmapUrl, setDynmapUrl] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState({ x: 20, y: 20 }); // Position from right and bottom
  const [isDragging, setIsDragging] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  
  // Use refs to avoid re-creating event handlers
  const positionRef = useRef(position);
  const dragStartRef = useRef({ x: 0, y: 0 });
  
  // Keep ref in sync with state
  useEffect(() => {
    positionRef.current = position;
  }, [position]);

  // Check if mobile on mount and window resize
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 920);
    };
    
    checkMobile();
    window.addEventListener('resize', checkMobile);
    
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  useEffect(() => {
    // Fetch the dynmap URL on mount
    const fetchDynmapUrl = async () => {
      try {
        const response = await fetchApi('/api/dynmap-url');
        const data = await response.json() as { url: string };
        setDynmapUrl(data.url);
      } catch (err) {
        setError('Failed to load dynmap URL');
        console.error('Failed to fetch dynmap URL:', err);
      }
    };

    fetchDynmapUrl();
  }, []);

  // Constrain position to window bounds - memoized
  const constrainPosition = useCallback((pos: { x: number; y: number }) => {
    const padding = 10; // Minimum distance from edges
    const panelWidth = Math.min(window.innerWidth * 0.9, 500);
    const panelHeight = Math.min(window.innerHeight * 0.7, 500);
    
    return {
      x: Math.max(padding, Math.min(pos.x, window.innerWidth - panelWidth - padding)),
      y: Math.max(padding, Math.min(pos.y, window.innerHeight - panelHeight - padding)),
    };
  }, []);

  // Handle window resize - keep panel in bounds
  useEffect(() => {
    const handleResize = () => {
      setPosition(prev => constrainPosition(prev));
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [constrainPosition]);

  // Handle dragging - stable event handlers that don't re-create
  useEffect(() => {
    if (!isDragging || isMobile) return;

    const handleMouseMove = (e: MouseEvent) => {
      // Use refs to get current values without causing re-renders
      const currentPos = positionRef.current;
      const currentDragStart = dragStartRef.current;
      
      // For right positioning: when mouse moves right (+X), we want right value to decrease
      const deltaX = currentDragStart.x - e.clientX;
      // For bottom positioning: when mouse moves down (+Y), we want bottom value to decrease
      const deltaY = currentDragStart.y - e.clientY;
      
      const newPosition = constrainPosition({
        x: currentPos.x + deltaX,
        y: currentPos.y + deltaY,
      });
      
      // Update both ref and state
      dragStartRef.current = { x: e.clientX, y: e.clientY };
      setPosition(newPosition);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, isMobile, constrainPosition]);

  const handleDragStart = useCallback((e: MouseEvent) => {
    if (isMobile) return; // Disable drag on mobile
    e.preventDefault(); // Prevent text selection
    setIsDragging(true);
    dragStartRef.current = { x: e.clientX, y: e.clientY };
  }, [isMobile]);

  if (error || !dynmapUrl) {
    return null; // Don't show if there's an error or no URL
  }

  // Only show when server is running
  if (serverState !== 'running') {
    return null;
  }

  return (
    <>
      {/* Enchanted glint animations */}
      <style>{`
        @keyframes enchantedGlint {
          0% {
            transform: translateX(-150%) translateY(-150%) rotate(45deg);
            opacity: 0;
          }
          10% {
            opacity: 0.8;
          }
          50% {
            opacity: 0.6;
          }
          90% {
            opacity: 0;
          }
          100% {
            transform: translateX(150%) translateY(150%) rotate(45deg);
            opacity: 0;
          }
        }

        @keyframes enchantedGlintSecondary {
          0% {
            transform: translateX(-180%) translateY(-180%) rotate(45deg);
            opacity: 0;
          }
          15% {
            opacity: 0.5;
          }
          60% {
            opacity: 0.3;
          }
          95% {
            opacity: 0;
          }
          100% {
            transform: translateX(180%) translateY(180%) rotate(45deg);
            opacity: 0;
          }
        }

        @keyframes idlePulse {
          0%, 100% {
            transform: scale(1);
            filter: brightness(1);
          }
          50% {
            transform: scale(1.03);
            filter: brightness(1.15);
          }
        }

        .minimap-button-enchanted {
          animation: idlePulse 4s ease-in-out infinite;
          position: relative;
          overflow: hidden;
        }

        .minimap-button-enchanted::before,
        .minimap-button-enchanted::after {
          content: '';
          position: absolute;
          top: -50%;
          left: -50%;
          width: 200%;
          height: 200%;
          background: linear-gradient(
            90deg,
            transparent 0%,
            transparent 40%,
            rgba(255, 255, 255, 0.8) 50%,
            transparent 60%,
            transparent 100%
          );
          pointer-events: none;
        }

        .minimap-button-enchanted::before {
          animation: enchantedGlint 7s ease-in-out 0s infinite;
        }

        .minimap-button-enchanted::after {
          background: linear-gradient(
            90deg,
            transparent 0%,
            transparent 35%,
            rgba(255, 255, 255, 0.4) 50%,
            transparent 65%,
            transparent 100%
          );
          animation: enchantedGlintSecondary 7s ease-in-out 0.5s infinite;
        }

        .minimap-button-enchanted:hover {
          animation: none !important;
        }
      `}</style>

      {/* Floating minimap button when collapsed */}
      {!isExpanded && (
        <button
          onClick={() => setIsExpanded(true)}
          className="minimap-button-enchanted"
          style={{
            position: 'fixed',
            bottom: '20px',
            right: '20px',
            width: '60px',
            height: '60px',
            borderRadius: '50%',
            background: 'linear-gradient(135deg, #55FF55 0%, #57A64E 100%)',
            border: 'none',
            cursor: 'pointer',
            fontSize: '1.5rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 4px 20px rgba(85, 255, 85, 0.4), 0 0 0 2px rgba(255, 255, 255, 0.1)',
            transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
            zIndex: 1000,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = 'scale(1.15)';
            e.currentTarget.style.boxShadow = '0 8px 36px rgba(85, 255, 85, 0.6), 0 0 0 3px rgba(255, 255, 255, 0.2)';
            e.currentTarget.style.filter = 'brightness(1.2)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = '';
            e.currentTarget.style.boxShadow = '0 4px 20px rgba(85, 255, 85, 0.4), 0 0 0 2px rgba(255, 255, 255, 0.1)';
            e.currentTarget.style.filter = '';
          }}
          title="Open Minimap"
        >
          🗺️
        </button>
      )}

      {/* Single minimap panel with persistent iframe */}
      <div
        style={isExpanded ? (
          isMobile ? {
            // Mobile: sheet style at bottom
            position: 'fixed',
            bottom: 0,
            left: 0,
            right: 0,
            width: '100%',
            height: '85vh',
            maxHeight: '85vh',
            background: 'rgba(10, 22, 18, 0.98)',
            border: 'none',
            borderTop: '2px solid rgba(87, 166, 78, 0.3)',
            borderRadius: '16px 16px 0 0',
            boxShadow: '0 -4px 32px rgba(0, 0, 0, 0.6)',
            zIndex: 1000,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            backdropFilter: 'blur(10px)',
          } : {
            // Desktop: draggable floating panel
            position: 'fixed',
            bottom: `${position.y}px`,
            right: `${position.x}px`,
            width: 'min(90vw, 500px)',
            height: 'min(70vh, 500px)',
            background: 'rgba(10, 22, 18, 0.95)',
            border: '2px solid rgba(87, 166, 78, 0.3)',
            borderRadius: '12px',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)',
            zIndex: 1000,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            backdropFilter: 'blur(10px)',
          }
        ) : {
          // Collapsed: keep iframe mounted but hidden/off-screen for preloading
          position: 'fixed',
          bottom: '-9999px',
          left: '-9999px',
          width: '500px',
          height: '500px',
          visibility: 'hidden',
          pointerEvents: 'none',
          opacity: 0,
          zIndex: 1000,
        }}
      >
        {/* Header (only when expanded) */}
        {isExpanded && (
          <div
            onMouseDown={handleDragStart}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '12px 16px',
              background: 'rgba(87, 166, 78, 0.15)',
              borderBottom: '1px solid rgba(87, 166, 78, 0.3)',
              cursor: isMobile ? 'default' : (isDragging ? 'grabbing' : 'grab'),
              userSelect: 'none',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '1.25rem' }}>🗺️</span>
              <span style={{ fontWeight: '600', color: '#57A64E' }}>
                Live Map
              </span>
            </div>
            <button
              onClick={() => setIsExpanded(false)}
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '6px',
                background: 'rgba(255, 107, 107, 0.15)',
                border: '1px solid rgba(255, 107, 107, 0.3)',
                color: '#ff6b6b',
                cursor: 'pointer',
                fontSize: '1.125rem',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'all 0.2s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(255, 107, 107, 0.25)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'rgba(255, 107, 107, 0.15)';
              }}
              title="Close minimap"
            >
              ✕
            </button>
          </div>
        )}

        {/* Iframe container (always mounted) */}
        <div style={{ position: 'relative', width: '100%', height: '100%', flex: 1 }}>
          <iframe
            src={dynmapUrl + "?zoom=3"}
            style={{
              width: '100%',
              height: '100%',
              border: 'none',
              display: 'block',
            }}
            title="Minecraft Dynmap"
            allow="fullscreen"
          />
        </div>

        {/* Footer with expand button (only when expanded) */}
        {isExpanded && (
          <div
            style={{
              padding: '8px 16px',
              background: 'rgba(87, 166, 78, 0.1)',
              borderTop: '1px solid rgba(87, 166, 78, 0.2)',
              display: 'flex',
              justifyContent: 'flex-end',
            }}
          >
            <a
              href={dynmapUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                fontSize: '0.875rem',
                color: '#57A64E',
                textDecoration: 'none',
                padding: '4px 12px',
                borderRadius: '4px',
                transition: 'background 0.2s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(87, 166, 78, 0.15)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
              }}
            >
              Open in new tab ↗
            </a>
          </div>
        )}
      </div>
    </>
  );
}

