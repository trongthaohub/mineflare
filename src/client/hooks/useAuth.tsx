import { useState, useEffect, useCallback } from 'preact/hooks';
import { fetchApi } from '../utils/api';

interface AuthState {
  passwordSet: boolean;
  authenticated: boolean;
  loading: boolean;
  error: string | null;
}

export function useAuth() {
  const [state, setState] = useState<AuthState>({
    passwordSet: true, // Default to login screen (most common case)
    authenticated: false,
    loading: true,
    error: null,
  });

  const checkStatus = useCallback(async () => {
    try {
      setState(prev => ({ ...prev, loading: true, error: null }));
      const response = await fetchApi('/api/auth/status');
      const data = await response.json() as { passwordSet: boolean; authenticated: boolean };
      setState({
        passwordSet: data.passwordSet,
        authenticated: data.authenticated,
        loading: false,
        error: null,
      });
    } catch (error) {
      console.error('Failed to check auth status:', error);
      setState({
        passwordSet: false,
        authenticated: false,
        loading: false,
        error: error instanceof Error ? error.message : 'Failed to check auth status',
      });
    }
  }, []);

  const setup = useCallback(async (password: string): Promise<{ success: boolean; error?: string }> => {
    try {
      setState(prev => ({ ...prev, loading: true, error: null }));
      const response = await fetchApi('/api/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      
      const data = await response.json() as { success?: boolean; error?: string };
      
      if (!response.ok) {
        setState(prev => ({ ...prev, loading: false, error: data.error || 'Setup failed' }));
        return { success: false, error: data.error || 'Setup failed' };
      }
      
      // Success - check status to update state
      await checkStatus();
      return { success: true };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Setup failed';
      setState(prev => ({ ...prev, loading: false, error: errorMsg }));
      return { success: false, error: errorMsg };
    }
  }, [checkStatus]);

  const login = useCallback(async (password: string): Promise<{ success: boolean; error?: string }> => {
    try {
      setState(prev => ({ ...prev, loading: true, error: null }));
      const response = await fetchApi('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      
      const data = await response.json() as { success?: boolean; error?: string };
      
      if (!response.ok) {
        setState(prev => ({ ...prev, loading: false, error: data.error || 'Login failed' }));
        return { success: false, error: data.error || 'Login failed' };
      }
      
      // Success - check status to update state
      await checkStatus();
      return { success: true };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Login failed';
      setState(prev => ({ ...prev, loading: false, error: errorMsg }));
      return { success: false, error: errorMsg };
    }
  }, [checkStatus]);

  const logout = useCallback(async () => {
    try {
      setState(prev => ({ ...prev, loading: true, error: null }));
      await fetchApi('/api/auth/logout', { method: 'POST' });
      setState({
        passwordSet: true, // Password is still set, just logged out
        authenticated: false,
        loading: false,
        error: null,
      });
    } catch (error) {
      console.error('Failed to logout:', error);
      setState(prev => ({ ...prev, loading: false, error: 'Logout failed' }));
    }
  }, []);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  return {
    passwordSet: state.passwordSet,
    authenticated: state.authenticated,
    loading: state.loading,
    error: state.error,
    setup,
    login,
    logout,
    checkStatus,
  };
}

