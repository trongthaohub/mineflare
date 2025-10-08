import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import type { ServerStatus, PlayerResponse, ServerInfo, Plugin } from '../types/api';
import { fetchWithAuth } from '../utils/api';

type ServerState = 'stopped' | 'starting' | 'running' | 'stopping';

export function useServerData(isAuthenticated: boolean) {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [players, setPlayers] = useState<string[]>([]);
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverState, setServerState] = useState<ServerState>('stopped');
  const [startupStep, setStartupStep] = useState<string | null>(null);
  
  // Track active fetch calls for concurrency safety
  const activeFetches = useRef<Set<Promise<any>>>(new Set());
  const shouldFetchFullData = useRef(false);

  // Unified polling function that handles all states
  const poll = useCallback(async () => {
    const fetchPromise = (async () => {
      try {
        // First, check the container state (doesn't wake container)
        const stateResponse = await fetchWithAuth(`/api/getState`);
        const stateData = await stateResponse.json() as { status: string; lastChange: number };
        const containerRunning = stateData.status === 'running' || stateData.status === 'healthy';
        const containerStopping = stateData.status === 'stopping';
        const containerStopped = stateData.status === 'stopped' || stateData.status === 'stopped_with_code';
        
        // If we're stopping, hold UI in 'stopping' until container is actually stopped
        if (serverState === 'stopping') {
          if (containerStopped || (!containerRunning && !containerStopping)) {
            setServerState('stopped');
            setStatus({ online: false, playerCount: 0, maxPlayers: 0 });
            setPlayers([]);
            shouldFetchFullData.current = false;
          }
          return;
        }

        if (shouldFetchFullData.current) {
          // We want to fetch full data (user started server or it's running)
          if (containerRunning) {
            // Container is running, fetch full server data
            setLoading(true);
            setError(null);
            
            const statusResponse = await fetchWithAuth(`/api/status`);
            const statusData: ServerStatus = await statusResponse.json();
            setStatus(statusData);
            
            if (statusData.online) {
              setServerState('running');
            }

            const playersResponse = await fetchWithAuth(`/api/players`);
            const playersData: PlayerResponse = await playersResponse.json();
            setPlayers(playersData.players || []);

            const infoResponse = await fetchWithAuth(`/api/info`);
            const infoData: ServerInfo = await infoResponse.json();
            setInfo(infoData);

            // Also fetch plugins to keep state in sync
            await fetchPlugins();
          } else if (serverState === 'starting' && !containerStopping) {
            // We're trying to start - call /api/status to wake the container
            setLoading(true);
            setError(null);
            
            // Fetch startup status to get the current step
            try {
              const startupStatusResponse = await fetchWithAuth(`/api/startup-status`);
              const startupStatusData = await startupStatusResponse.json() as { status: string; startupStep: string | null };
              if (startupStatusData.startupStep) {
                setStartupStep(startupStatusData.startupStep);
              }
            } catch (err) {
              console.log('Failed to fetch startup step:', err);
            }
            
            const statusResponse = await fetchWithAuth(`/api/status`);
            const statusData: ServerStatus = await statusResponse.json();
            setStatus(statusData);
            
            if (statusData.online) {
              setServerState('running');
              setStartupStep(null); // Clear startup step when fully running
              
              // Also fetch players and info
              const playersResponse = await fetchWithAuth(`/api/players`);
              const playersData: PlayerResponse = await playersResponse.json();
              setPlayers(playersData.players || []);

              const infoResponse = await fetchWithAuth(`/api/info`);
              const infoData: ServerInfo = await infoResponse.json();
              setInfo(infoData);

              // Also fetch plugins to keep state in sync
              await fetchPlugins();
            }
            // If not online yet, stay in 'starting' state
          } else if (!containerRunning && serverState === 'running') {
            // Was running but now stopped externally
            setServerState('stopped');
            setStatus({ online: false, playerCount: 0, maxPlayers: 0 });
            setPlayers([]);
            shouldFetchFullData.current = false;
            // Fetch plugins since we're now stopped and can edit them
            await fetchPlugins();
          }
        } else {
          // Just monitoring state changes (not actively fetching full data)
          if (containerRunning && serverState === 'stopped') {
            // Someone else started it
            setServerState('starting');
            shouldFetchFullData.current = true;
            // Will fetch on next poll
          } else if (!containerRunning && (serverState === 'running' || serverState === 'starting')) {
            // Server stopped externally while we thought it was running
            setServerState('stopped');
            setStatus({ online: false, playerCount: 0, maxPlayers: 0 });
            setPlayers([]);
            // Fetch plugins since we're now stopped and can edit them
            await fetchPlugins();
          }
        }
      } catch (err) {
        if (shouldFetchFullData.current) {
          setError(err instanceof Error ? err.message : 'Unknown error');
        }
        console.log('Poll error:', err);
      } finally {
        setLoading(false);
      }
    })();

    activeFetches.current.add(fetchPromise);
    try {
      await fetchPromise;
    } finally {
      activeFetches.current.delete(fetchPromise);
    }
  }, [serverState]);

  const startServer = async () => {
    setServerState('starting');
    setError(null);
    shouldFetchFullData.current = true;
    
    // Trigger immediate poll to wake the server
    await poll();
  };

  const stopServer = async () => {
    setServerState('stopping');
    setError(null);
    
    // Stop fetching full data
    shouldFetchFullData.current = false;
    
    // Wait for all active fetches to complete
    await Promise.all(Array.from(activeFetches.current));
    
    // Now send the stop command
    try {
      const response = await fetchWithAuth('/api/shutdown', {
        method: 'POST'
      });
      const result = await response.json() as { success: boolean; error?: string };
      
      if (result.success) {
        // Keep UI in 'stopping' until the container actually stops
        setStatus({ online: false, playerCount: 0, maxPlayers: 0 });
        setPlayers([]);
        await poll();
        // Fetch plugins since we're now stopped and can edit them
        await fetchPlugins();
      } else {
        setError(result.error || 'Failed to stop server');
        setServerState('running');
        shouldFetchFullData.current = true;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop server');
      setServerState('running');
      shouldFetchFullData.current = true;
    }
  };

  const refresh = useCallback(async () => {
    if (shouldFetchFullData.current) {
      await poll();
    }
  }, [poll]);

  const fetchPlugins = useCallback(async () => {
    try {
      const response = await fetchWithAuth('/api/plugins');
      const data = await response.json() as { plugins: Plugin[] };
      setPlugins(data.plugins || []);
    } catch (err) {
      console.error('Failed to fetch plugins:', err);
    }
  }, []);

  const togglePlugin = useCallback(async (filename: string, enabled: boolean) => {
    try {
      const response = await fetchWithAuth(`/api/plugins/${filename}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ enabled }),
      });
      
      const result = await response.json() as { success: boolean; plugins?: Plugin[]; error?: string };
      
      if (result.success && result.plugins) {
        setPlugins(result.plugins);
      } else {
        throw new Error(result.error || 'Failed to toggle plugin');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to toggle plugin');
      throw err;
    }
  }, []);

  useEffect(() => {
    // Only poll if authenticated
    if (!isAuthenticated) {
      return;
    }
    
    // Check server state immediately on mount
    poll();
    fetchPlugins();

    // Set up single unified polling interval
    const pollInterval = setInterval(() => {
      // Only start a new poll if there are no active fetches
      if (activeFetches.current.size === 0) {
        poll();
      }
    }, 5000);

    return () => {
      clearInterval(pollInterval);
    };
  }, [isAuthenticated, poll, fetchPlugins]);

  return {
    status,
    players,
    info,
    plugins,
    loading,
    error,
    serverState,
    startupStep,
    startServer,
    stopServer,
    refresh,
    fetchPlugins,
    togglePlugin
  };
}