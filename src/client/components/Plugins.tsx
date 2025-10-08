import { useState } from 'preact/hooks';
import type { Plugin } from '../types/api';
import { fetchApi } from '../utils/api';

interface Props {
  plugins: Plugin[];
  serverState: 'stopped' | 'starting' | 'running' | 'stopping';
  onPluginToggle: (filename: string, enabled: boolean) => Promise<void>;
}

const PLUGIN_INFO: Record<string, { emoji: string; description: string }> = {
  'Dynmap-3.7-beta-11-spigot': {
    emoji: '🗺️',
    description: 'DynMap powers the minimap feature and shows a live map of your world. Learn more at dynmap.wiki.gg'
  },
  'playit-minecraft-plugin': {
    emoji: '🌐',
    description: 'playit.gg allows you to connect your private servers to public URLs so that your friends can join your games.'
  }
};

export function Plugins({ plugins, serverState, onPluginToggle }: Props) {
  const [hoveredInfo, setHoveredInfo] = useState<string | null>(null);
  const [hoveredWarning, setHoveredWarning] = useState<string | null>(null);
  const [hoveredToggle, setHoveredToggle] = useState<string | null>(null);
  const [hoveredMessage, setHoveredMessage] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [envModalPlugin, setEnvModalPlugin] = useState<Plugin | null>(null);
  const [envModalMode, setEnvModalMode] = useState<'edit' | 'enable'>('edit');
  const [envFormData, setEnvFormData] = useState<Record<string, string>>({});
  const [envSaving, setEnvSaving] = useState(false);
  const [statusModalPlugin, setStatusModalPlugin] = useState<Plugin | null>(null);

  const openEnvModal = (plugin: Plugin, mode: 'edit' | 'enable') => {
    setEnvModalPlugin(plugin);
    setEnvModalMode(mode);
    // Pre-fill form with current configured values
    const initialData: Record<string, string> = {};
    plugin.requiredEnv.forEach(env => {
      initialData[env.name] = plugin.configuredEnv[env.name] || '';
    });
    setEnvFormData(initialData);
  };

  const closeEnvModal = () => {
    setEnvModalPlugin(null);
    setEnvFormData({});
    setEnvSaving(false);
  };

  const saveEnvVars = async (alsoEnable: boolean = false) => {
    if (!envModalPlugin) return;
    
    try {
      setEnvSaving(true);
      const body: any = { env: envFormData };
      if (alsoEnable) {
        body.enabled = true;
      }
      
      const response = await fetchApi(`/api/plugins/${envModalPlugin.filename}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      
      const result = await response.json() as { success: boolean; plugins?: Plugin[]; error?: string };
      
      if (result.success) {
        closeEnvModal();
        // Parent will update plugins state via polling
      } else {
        alert(result.error || 'Failed to update plugin environment variables');
      }
    } catch (error) {
      console.error('Failed to save env vars:', error);
      alert('Failed to save environment variables');
    } finally {
      setEnvSaving(false);
    }
  };

  const handleToggle = async (filename: string, currentState: string) => {
    if (serverState !== 'stopped') return;
    
    // Use the same logic as isPluginEnabled to determine current toggle state
    const isEnabled = currentState === 'ENABLED' || currentState === 'DISABLED_WILL_ENABLE_AFTER_RESTART';
    const newEnabled = !isEnabled;
    
    // If enabling a plugin with required env, check if env vars are configured
    if (newEnabled) {
      const plugin = plugins.find(p => p.filename === filename);
      if (plugin && plugin.requiredEnv.length > 0) {
        const hasAllEnv = plugin.requiredEnv.every(
          env => plugin.configuredEnv[env.name] && plugin.configuredEnv[env.name].trim() !== ''
        );
        
        if (!hasAllEnv) {
          // Open modal to prompt for env vars
          openEnvModal(plugin, 'enable');
          return;
        }
      }
    }
    
    try {
      setToggling(filename);
      await onPluginToggle(filename, newEnabled);
      // Parent will update plugins state
    } catch (error) {
      console.error('Failed to toggle plugin:', error);
      alert(error instanceof Error ? error.message : 'Failed to toggle plugin');
    } finally {
      setToggling(null);
    }
  };

  const getWarningTooltip = (state: string): string | null => {
    if (state === 'DISABLED_WILL_ENABLE_AFTER_RESTART') {
      return 'Will be enabled after server restart';
    }
    if (state === 'ENABLED_WILL_DISABLE_AFTER_RESTART') {
      return 'Will be disabled after server restart';
    }
    return null;
  };

  const isTransitionalState = (state: string) => {
    return state === 'DISABLED_WILL_ENABLE_AFTER_RESTART' || state === 'ENABLED_WILL_DISABLE_AFTER_RESTART';
  };

  const isPluginEnabled = (state: string) => {
    return state === 'ENABLED' || state === 'DISABLED_WILL_ENABLE_AFTER_RESTART';
  };

  const getStatusIcon = (status: Plugin['status']) => {
    switch (status.type) {
      case 'information':
        return { icon: 'ℹ️', color: '#4682B4', label: 'Information' };
      case 'warning':
        return { icon: '⚠️', color: '#FFB600', label: 'Warning' };
      case 'alert':
        return { icon: '🚨', color: '#FF4444', label: 'Alert' };
      default:
        return null;
    }
  };

  // Convert URLs in text to clickable links
  const renderMessageWithLinks = (message: string) => {
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const parts = message.split(urlRegex);
    
    return parts.map((part, index) => {
      if (part.match(urlRegex)) {
        return (
          <a
            key={index}
            href={part}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              color: 'inherit',
              textDecoration: 'underline',
              fontWeight: '600',
              transition: 'opacity 0.2s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.opacity = '0.7';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.opacity = '1';
            }}
          >
            {part}
          </a>
        );
      }
      return <span key={index}>{part}</span>;
    });
  };

  const canToggle = serverState === 'stopped';

  return (
    <>
      <style>{`
        @keyframes pulse-glow {
          0%, 100% {
            opacity: 1;
            box-shadow: 0 0 0 rgba(255, 182, 0, 0);
          }
          50% {
            opacity: 0.85;
            box-shadow: 0 0 8px rgba(255, 182, 0, 0.3);
          }
        }
      `}</style>
      <div style={{
      background: 'rgba(26, 46, 30, 0.4)',
      backdropFilter: 'blur(10px)',
      border: '1px solid rgba(87, 166, 78, 0.2)',
      borderRadius: '16px',
      padding: '32px',
      boxShadow: '0 8px 32px rgba(0, 0, 0, 0.3)',
      transition: 'all 0.3s ease',
    }}
    onMouseEnter={(e) => {
      e.currentTarget.style.borderColor = 'rgba(87, 166, 78, 0.4)';
      e.currentTarget.style.transform = 'translateY(-4px)';
      e.currentTarget.style.boxShadow = '0 12px 40px rgba(0, 0, 0, 0.4)';
    }}
    onMouseLeave={(e) => {
      e.currentTarget.style.borderColor = 'rgba(87, 166, 78, 0.2)';
      e.currentTarget.style.transform = 'translateY(0)';
      e.currentTarget.style.boxShadow = '0 8px 32px rgba(0, 0, 0, 0.3)';
    }}
    >
      <div style={{
        display: 'flex',
        alignItems: 'center',
        marginBottom: '24px',
      }}>
        <div style={{
          width: '48px',
          height: '48px',
          borderRadius: '12px',
          background: 'linear-gradient(135deg, #4682B4 0%, #5B9BD5 100%)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '1.5rem',
          marginRight: '16px',
          boxShadow: '0 4px 12px rgba(70, 130, 180, 0.3)',
        }}>
          🔌
        </div>
        <div>
          <h2 style={{
            margin: '0 0 4px 0',
            fontSize: '1.5rem',
            fontWeight: '700',
            color: '#fff',
          }}>
            Server Plugins
          </h2>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}>
            <span style={{
              color: canToggle ? '#55FF55' : '#888',
              fontWeight: '600',
              fontSize: '0.875rem',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}>
              {canToggle ? 'Editable' : 'Stop server to edit'}
            </span>
          </div>
        </div>
      </div>

      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
      }}>
        {plugins.map((plugin) => {
          const info = PLUGIN_INFO[plugin.filename];
          const enabled = isPluginEnabled(plugin.state);
          const transitional = isTransitionalState(plugin.state);
          const warningTooltip = getWarningTooltip(plugin.state);
          const isDynmap = plugin.filename === 'Dynmap-3.7-beta-11-spigot';
          const isTogglingThis = toggling === plugin.filename;
          const statusIcon = getStatusIcon(plugin.status);

          return (
            <div
              key={plugin.filename}
              style={{
                background: 'rgba(255, 255, 255, 0.03)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                borderRadius: '12px',
                padding: '16px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                transition: 'all 0.2s ease',
                opacity: isTogglingThis ? 0.6 : 1,
              }}
            >
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                flex: 1,
                minWidth: 0,
              }}>
                <span style={{ fontSize: '1.5rem', flexShrink: 0 }}>
                  {info?.emoji || '🔌'}
                </span>
                <div style={{ 
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  minWidth: 0,
                  flex: 1,
                }}>
                  <div style={{ flexShrink: 0 }}>
                    <div style={{
                      color: '#fff',
                      fontWeight: '600',
                      fontSize: '0.9375rem',
                      marginBottom: '2px',
                    }}>
                      {plugin.displayName}
                    </div>
                    <div style={{
                      color: '#888',
                      fontSize: '0.75rem',
                    }}>
                      {enabled ? 'Active' : 'Inactive'}
                    </div>
                  </div>
                  
                  {/* Message preview for warnings/alerts */}
                  {statusIcon && plugin.status.type !== 'no message' && (() => {
                    const message = 'message' in plugin.status ? plugin.status.message : '';
                    return (
                      <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
                        <div
                          onClick={() => setStatusModalPlugin(plugin)}
                          style={{
                            fontFamily: '"Courier New", Courier, monospace',
                            fontSize: '0.8rem',
                            lineHeight: '1.4',
                            color: statusIcon.color === '#FF4444'
                              ? '#ffaaaa'
                              : statusIcon.color === '#FFB600'
                              ? '#ffd666'
                              : '#88b3dd',
                            cursor: 'pointer',
                            transition: 'all 0.2s ease',
                            display: '-webkit-box',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            minWidth: 0,
                            paddingRight: '8px',
                          } as any}
                          onMouseEnter={(e) => {
                            setHoveredMessage(plugin.filename);
                            e.currentTarget.style.textDecoration = 'underline';
                            e.currentTarget.style.opacity = '0.8';
                          }}
                          onMouseLeave={(e) => {
                            setHoveredMessage(null);
                            e.currentTarget.style.textDecoration = 'none';
                            e.currentTarget.style.opacity = '1';
                          }}
                        >
                          {statusIcon.icon} {message}
                        </div>
                        
                        {/* Tooltip */}
                        {hoveredMessage === plugin.filename && (
                          <div style={{
                            position: 'absolute',
                            bottom: '100%',
                            left: '0',
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
                            Click to view full {statusIcon.label.toLowerCase()}
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
              </div>

              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
              }}>
                {/* Env vars icon for plugins with required env */}
                {plugin.requiredEnv.length > 0 && (
                  <button
                    onClick={() => openEnvModal(plugin, 'edit')}
                    style={{
                      width: '24px',
                      height: '24px',
                      borderRadius: '50%',
                      background: 'rgba(70, 130, 180, 0.2)',
                      border: '1px solid rgba(70, 130, 180, 0.3)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '0.875rem',
                      cursor: 'pointer',
                      transition: 'all 0.2s ease',
                      opacity: 1,
                      padding: 0,
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'rgba(70, 130, 180, 0.3)';
                      e.currentTarget.style.borderColor = 'rgba(70, 130, 180, 0.5)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'rgba(70, 130, 180, 0.2)';
                      e.currentTarget.style.borderColor = 'rgba(70, 130, 180, 0.3)';
                    }}
                    title={serverState === 'stopped' ? 'Configure environment variables' : 'View environment variables'}
                  >
                    ⚙️
                  </button>
                )}

                {/* Warning icon for transitional states (only show when server is running) */}
                {transitional && warningTooltip && serverState === 'running' && (
                  <div
                    style={{
                      position: 'relative',
                      cursor: 'help',
                    }}
                    onMouseEnter={() => setHoveredWarning(plugin.filename)}
                    onMouseLeave={() => setHoveredWarning(null)}
                  >
                    <span style={{
                      fontSize: '1.125rem',
                      color: '#FFB600',
                    }}>
                      ⚠️
                    </span>
                    {hoveredWarning === plugin.filename && (
                      <div style={{
                        position: 'absolute',
                        bottom: '100%',
                        right: '0',
                        marginBottom: '8px',
                        padding: '8px 12px',
                        background: 'rgba(0, 0, 0, 0.95)',
                        border: '1px solid rgba(255, 182, 0, 0.3)',
                        borderRadius: '8px',
                        color: '#FFB600',
                        fontSize: '0.75rem',
                        whiteSpace: 'nowrap',
                        zIndex: 1000,
                        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.5)',
                      }}>
                        {warningTooltip}
                      </div>
                    )}
                  </div>
                )}

                {/* Info button */}
                {info && (
                  <div
                    style={{
                      position: 'relative',
                      cursor: 'help',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '1.5rem',
                    }}
                    onMouseEnter={() => setHoveredInfo(plugin.filename)}
                    onMouseLeave={() => setHoveredInfo(null)}
                  >
                    📖
                    {hoveredInfo === plugin.filename && (
                      <div style={{
                        position: 'absolute',
                        bottom: '100%',
                        right: '0',
                        marginBottom: '8px',
                        padding: '12px',
                        background: 'rgba(0, 0, 0, 0.95)',
                        border: '1px solid rgba(87, 166, 78, 0.3)',
                        borderRadius: '8px',
                        color: '#b0b0b0',
                        fontSize: '0.75rem',
                        width: '250px',
                        zIndex: 1000,
                        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.5)',
                        lineHeight: '1.4',
                      }}>
                        {info.description}
                      </div>
                    )}
                  </div>
                )}

                {/* Toggle switch */}
                <div style={{ position: 'relative' }}>
                  <button
                    onClick={() => !isDynmap && handleToggle(plugin.filename, plugin.state)}
                    disabled={!canToggle || isDynmap || isTogglingThis}
                    style={{
                      position: 'relative',
                      width: '48px',
                      height: '24px',
                      borderRadius: '12px',
                      background: enabled 
                        ? 'linear-gradient(135deg, #57A64E 0%, #6BB854 100%)' 
                        : 'rgba(120, 120, 120, 0.3)',
                      border: enabled 
                        ? '2px solid rgba(87, 166, 78, 0.5)' 
                        : '2px solid rgba(160, 160, 160, 0.4)',
                      cursor: (canToggle && !isDynmap && !isTogglingThis) ? 'pointer' : 'not-allowed',
                      transition: 'all 0.3s ease',
                      padding: 0,
                      opacity: (!canToggle || isDynmap) ? 0.5 : 1,
                      overflow: 'visible',
                    }}
                    onMouseEnter={(e) => {
                      setHoveredToggle(plugin.filename);
                      if (canToggle && !isDynmap && !isTogglingThis && !enabled) {
                        e.currentTarget.style.background = 'rgba(140, 140, 140, 0.4)';
                        e.currentTarget.style.borderColor = 'rgba(180, 180, 180, 0.5)';
                      }
                    }}
                    onMouseLeave={(e) => {
                      setHoveredToggle(null);
                      if (!enabled) {
                        e.currentTarget.style.background = 'rgba(120, 120, 120, 0.3)';
                        e.currentTarget.style.borderColor = 'rgba(160, 160, 160, 0.4)';
                      }
                    }}
                  >
                  {/* Dynmap required overlay */}
                  {isDynmap && (
                    <div style={{
                      position: 'absolute',
                      top: '50%',
                      left: '50%',
                      transform: 'translate(-50%, -50%) rotate(-12deg)',
                      fontSize: '0.5rem',
                      fontWeight: '800',
                      color: 'rgb(187 18 0)',
                      letterSpacing: '0.02em',
                      pointerEvents: 'none',
                      whiteSpace: 'nowrap',
                      zIndex: 2,
                    }}>
                      REQUIRED
                    </div>
                  )}
                  
                  <div style={{
                    position: 'absolute',
                    top: '2px',
                    left: enabled ? 'calc(100% - 22px)' : '2px',
                    width: '16px',
                    height: '16px',
                    borderRadius: '50%',
                    background: enabled ? '#fff' : '#b0b0b0',
                    boxShadow: '0 2px 4px rgba(0, 0, 0, 0.2)',
                    transition: 'all 0.3s ease',
                  }} />
                </button>
                
                {/* Custom tooltip for toggle */}
                {hoveredToggle === plugin.filename && (isDynmap || !canToggle) && (
                  <div style={{
                    position: 'absolute',
                    bottom: '100%',
                    right: '0',
                    marginBottom: '8px',
                    padding: '8px 12px',
                    background: 'rgba(0, 0, 0, 0.95)',
                    border: isDynmap 
                      ? '1px solid rgba(255, 153, 153, 0.3)' 
                      : '1px solid rgba(87, 166, 78, 0.3)',
                    borderRadius: '8px',
                    color: isDynmap ? '#ff9999' : '#b0b0b0',
                    fontSize: '0.75rem',
                    whiteSpace: 'nowrap',
                    zIndex: 1000,
                    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.5)',
                    pointerEvents: 'none',
                  }}>
                    {isDynmap ? 'Dynmap cannot be disabled' : 'Stop the server to change plugins'}
                  </div>
                )}
              </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Status Message Modal - Terminal Style */}
      {statusModalPlugin && statusModalPlugin.status.type !== 'no message' && (() => {
        const statusIcon = getStatusIcon(statusModalPlugin.status);
        const terminalColor = statusIcon?.color === '#FF4444'
          ? '#ffaaaa'
          : statusIcon?.color === '#FFB600'
          ? '#ffd666'
          : '#88b3dd';
        
        return (
          <div
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 10000,
              padding: '20px',
            }}
            onClick={() => setStatusModalPlugin(null)}
          >
            <div
              style={{
                background: '#0a0a0a',
                border: `2px solid ${terminalColor}`,
                borderRadius: '8px',
                padding: '0',
                maxWidth: '600px',
                width: '100%',
                boxShadow: `0 20px 60px rgba(0, 0, 0, 0.5), 0 0 20px ${statusIcon?.color}33`,
                fontFamily: '"Courier New", Courier, monospace',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Terminal Header */}
              <div style={{
                background: terminalColor,
                padding: '12px 20px',
                borderTopLeftRadius: '6px',
                borderTopRightRadius: '6px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}>
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                }}>
                  <span style={{ fontSize: '1rem' }}>{statusIcon?.icon}</span>
                  <span style={{
                    color: '#000',
                    fontWeight: '700',
                    fontSize: '0.875rem',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}>
                    {statusIcon?.label} - {statusModalPlugin.displayName}
                  </span>
                </div>
                <button
                  onClick={() => setStatusModalPlugin(null)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#000',
                    fontSize: '1.25rem',
                    cursor: 'pointer',
                    padding: '0',
                    lineHeight: 1,
                    fontWeight: '700',
                  }}
                >
                  ×
                </button>
              </div>

              {/* Terminal Content */}
              <div style={{
                padding: '24px',
                background: '#0a0a0a',
                color: terminalColor,
                fontSize: '0.875rem',
                lineHeight: '1.6',
                wordBreak: 'break-word',
                maxHeight: '400px',
                overflowY: 'auto',
                borderBottomLeftRadius: '6px',
                borderBottomRightRadius: '6px',
              }}>
                <div style={{
                  whiteSpace: 'pre-wrap',
                }}>
                  {renderMessageWithLinks('message' in statusModalPlugin.status ? statusModalPlugin.status.message : '')}
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Environment Variables Modal */}
      {envModalPlugin && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0, 0, 0, 0.8)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 10000,
          padding: '20px',
        }}
        onClick={closeEnvModal}
        >
          <div style={{
            background: 'rgba(26, 46, 30, 0.95)',
            backdropFilter: 'blur(20px)',
            border: '2px solid rgba(87, 166, 78, 0.3)',
            borderRadius: '16px',
            padding: '32px',
            maxWidth: '500px',
            width: '100%',
            boxShadow: '0 20px 60px rgba(0, 0, 0, 0.5)',
          }}
          onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{
              margin: '0 0 8px 0',
              fontSize: '1.5rem',
              fontWeight: '700',
              color: '#fff',
            }}>
              {envModalMode === 'enable' ? 'Configure & Enable' : (serverState !== 'stopped' ? 'Environment Variables (View Only)' : 'Environment Variables')}
            </h3>
            <p style={{
              margin: '0 0 24px 0',
              color: '#888',
              fontSize: '0.875rem',
            }}>
              {envModalPlugin.displayName}
              {envModalMode === 'enable' && ' - Please configure required environment variables to enable this plugin'}
              {envModalMode === 'edit' && serverState !== 'stopped' && ' - Stop server to edit'}
            </p>

            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '16px',
              marginBottom: '24px',
            }}>
              {envModalPlugin.requiredEnv.map((env) => (
                <div key={env.name}>
                  <label style={{
                    display: 'block',
                    color: '#fff',
                    fontSize: '0.875rem',
                    fontWeight: '600',
                    marginBottom: '6px',
                  }}>
                    {env.name}
                  </label>
                  <p style={{
                    margin: '0 0 8px 0',
                    color: '#888',
                    fontSize: '0.75rem',
                  }}>
                    {env.description}
                  </p>
                  <input
                    type="text"
                    value={envFormData[env.name] || ''}
                    onChange={(e) => setEnvFormData({ ...envFormData, [env.name]: e.currentTarget.value })}
                    disabled={serverState !== 'stopped' && envModalMode === 'edit'}
                    style={{
                      width: '100%',
                      padding: '10px 12px',
                      background: 'rgba(255, 255, 255, 0.05)',
                      border: '1px solid rgba(255, 255, 255, 0.1)',
                      borderRadius: '8px',
                      color: '#fff',
                      fontSize: '0.875rem',
                      fontFamily: 'monospace',
                      outline: 'none',
                      transition: 'all 0.2s ease',
                      opacity: (serverState !== 'stopped' && envModalMode === 'edit') ? 0.5 : 1,
                    }}
                    onFocus={(e) => {
                      e.currentTarget.style.borderColor = 'rgba(87, 166, 78, 0.4)';
                      e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)';
                    }}
                    onBlur={(e) => {
                      e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)';
                      e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)';
                    }}
                    placeholder={`Enter ${env.name}`}
                  />
                </div>
              ))}
            </div>

            {serverState !== 'stopped' && envModalMode === 'edit' && (
              <p style={{
                margin: '0 0 16px 0',
                color: '#FFB600',
                fontSize: '0.75rem',
                padding: '8px 12px',
                background: 'rgba(255, 182, 0, 0.1)',
                border: '1px solid rgba(255, 182, 0, 0.3)',
                borderRadius: '8px',
              }}>
                ⚠️ Server must be stopped to change environment variables
              </p>
            )}

            <div style={{
              display: 'flex',
              gap: '12px',
              justifyContent: 'flex-end',
            }}>
              <button
                onClick={closeEnvModal}
                disabled={envSaving}
                style={{
                  padding: '10px 20px',
                  background: 'rgba(120, 120, 120, 0.3)',
                  border: '1px solid rgba(160, 160, 160, 0.4)',
                  borderRadius: '8px',
                  color: '#fff',
                  fontSize: '0.875rem',
                  fontWeight: '600',
                  cursor: envSaving ? 'not-allowed' : 'pointer',
                  transition: 'all 0.2s ease',
                  opacity: envSaving ? 0.5 : 1,
                }}
                onMouseEnter={(e) => {
                  if (!envSaving) {
                    e.currentTarget.style.background = 'rgba(140, 140, 140, 0.4)';
                    e.currentTarget.style.borderColor = 'rgba(180, 180, 180, 0.5)';
                  }
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'rgba(120, 120, 120, 0.3)';
                  e.currentTarget.style.borderColor = 'rgba(160, 160, 160, 0.4)';
                }}
              >
                {envModalMode === 'enable' ? 'Cancel' : 'Close'}
              </button>
              
              {envModalMode === 'enable' ? (
                <button
                  onClick={() => saveEnvVars(true)}
                  disabled={envSaving}
                  style={{
                    padding: '10px 20px',
                    background: 'linear-gradient(135deg, #57A64E 0%, #6BB854 100%)',
                    border: '2px solid rgba(87, 166, 78, 0.5)',
                    borderRadius: '8px',
                    color: '#fff',
                    fontSize: '0.875rem',
                    fontWeight: '600',
                    cursor: envSaving ? 'not-allowed' : 'pointer',
                    transition: 'all 0.2s ease',
                    opacity: envSaving ? 0.7 : 1,
                  }}
                  onMouseEnter={(e) => {
                    if (!envSaving) {
                      e.currentTarget.style.transform = 'translateY(-2px)';
                      e.currentTarget.style.boxShadow = '0 4px 12px rgba(87, 166, 78, 0.4)';
                    }
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.transform = 'translateY(0)';
                    e.currentTarget.style.boxShadow = 'none';
                  }}
                >
                  {envSaving ? 'Saving...' : 'Complete & Enable'}
                </button>
              ) : (
                <button
                  onClick={() => saveEnvVars(false)}
                  disabled={envSaving || serverState !== 'stopped'}
                  style={{
                    padding: '10px 20px',
                    background: (serverState === 'stopped' && !envSaving)
                      ? 'linear-gradient(135deg, #57A64E 0%, #6BB854 100%)'
                      : 'rgba(120, 120, 120, 0.3)',
                    border: (serverState === 'stopped' && !envSaving)
                      ? '2px solid rgba(87, 166, 78, 0.5)'
                      : '1px solid rgba(160, 160, 160, 0.4)',
                    borderRadius: '8px',
                    color: '#fff',
                    fontSize: '0.875rem',
                    fontWeight: '600',
                    cursor: (serverState === 'stopped' && !envSaving) ? 'pointer' : 'not-allowed',
                    transition: 'all 0.2s ease',
                    opacity: (serverState === 'stopped' && !envSaving) ? 1 : 0.5,
                  }}
                  onMouseEnter={(e) => {
                    if (serverState === 'stopped' && !envSaving) {
                      e.currentTarget.style.transform = 'translateY(-2px)';
                      e.currentTarget.style.boxShadow = '0 4px 12px rgba(87, 166, 78, 0.4)';
                    }
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.transform = 'translateY(0)';
                    e.currentTarget.style.boxShadow = 'none';
                  }}
                >
                  {envSaving ? 'Saving...' : 'Save'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      </div>
    </>
  );
}

