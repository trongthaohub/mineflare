import { useState } from 'preact/hooks';

interface LoginProps {
  passwordSet: boolean;
  onSetup: (password: string) => Promise<{ success: boolean; error?: string }>;
  onLogin: (password: string) => Promise<{ success: boolean; error?: string }>;
  loading: boolean;
}

export function Login({ passwordSet, onSetup, onLogin, loading }: LoginProps) {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    setError('');

    if (!password) {
      setError('Password is required');
      return;
    }

    if (!passwordSet) {
      // Setup mode
      if (password.length < 8) {
        setError('Password must be at least 8 characters');
        return;
      }

      if (password !== confirmPassword) {
        setError('Passwords do not match');
        return;
      }

      setIsSubmitting(true);
      const result = await onSetup(password);
      setIsSubmitting(false);

      if (!result.success) {
        setError(result.error || 'Setup failed');
      }
    } else {
      // Login mode
      setIsSubmitting(true);
      const result = await onLogin(password);
      setIsSubmitting(false);

      if (!result.success) {
        setError(result.error || 'Invalid password');
        setPassword('');
      }
    }
  };

  const isDisabled = loading || isSubmitting;

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      zIndex: 9999,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'linear-gradient(135deg, #0a1612 0%, #1a2e1e 50%, #2a1810 100%)',
      fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      padding: '20px',
    }}>
      <div style={{
        width: '100%',
        maxWidth: '420px',
        background: 'rgba(26, 46, 30, 0.6)',
        backdropFilter: 'blur(20px)',
        border: '1px solid rgba(87, 166, 78, 0.3)',
        borderRadius: '24px',
        padding: '48px',
        boxShadow: '0 24px 64px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.05)',
      }}>
        {/* Logo/Icon */}
        <div style={{
          textAlign: 'center',
          marginBottom: '32px',
        }}>
          <div style={{
            width: '80px',
            height: '80px',
            margin: '0 auto 20px',
            borderRadius: '20px',
            background: 'linear-gradient(135deg, #55FF55 0%, #57A64E 100%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '2.5rem',
            boxShadow: '0 8px 24px rgba(85, 255, 85, 0.3)',
          }}>
            🔐
          </div>
          <h1 style={{
            fontSize: '1.75rem',
            fontWeight: '800',
            margin: '0 0 8px 0',
            background: 'linear-gradient(135deg, #55FF55 0%, #FFB600 100%)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            backgroundClip: 'text',
          }}>
            {passwordSet ? 'Welcome Back' : 'Setup Password'}
          </h1>
          <p style={{
            fontSize: '0.9rem',
            color: '#888',
            margin: 0,
          }}>
            {passwordSet 
              ? 'Enter your password to access the control panel'
              : 'Create a password to secure this control panel'
            }
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit}>
          {/* Password field */}
          <div style={{ marginBottom: '20px' }}>
            <label style={{
              display: 'block',
              fontSize: '0.875rem',
              fontWeight: '600',
              color: '#b0b0b0',
              marginBottom: '8px',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}>
              Password
            </label>
            <input
              type="password"
              value={password}
              onInput={(e) => setPassword(e.currentTarget.value)}
              disabled={isDisabled}
              placeholder="Enter password"
              style={{
                width: '100%',
                padding: '14px 16px',
                background: 'rgba(0, 0, 0, 0.3)',
                border: '1px solid rgba(87, 166, 78, 0.3)',
                borderRadius: '12px',
                color: '#e0e0e0',
                fontSize: '1rem',
                outline: 'none',
                transition: 'all 0.2s ease',
                opacity: isDisabled ? 0.6 : 1,
              }}
              onFocus={(e) => {
                if (!isDisabled) {
                  e.currentTarget.style.borderColor = 'rgba(87, 166, 78, 0.6)';
                  e.currentTarget.style.background = 'rgba(0, 0, 0, 0.4)';
                }
              }}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = 'rgba(87, 166, 78, 0.3)';
                e.currentTarget.style.background = 'rgba(0, 0, 0, 0.3)';
              }}
            />
          </div>

          {/* Confirm password field (setup mode only) */}
          {!passwordSet && (
            <div style={{ marginBottom: '20px' }}>
              <label style={{
                display: 'block',
                fontSize: '0.875rem',
                fontWeight: '600',
                color: '#b0b0b0',
                marginBottom: '8px',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}>
                Confirm Password
              </label>
              <input
                type="password"
                value={confirmPassword}
                onInput={(e) => setConfirmPassword(e.currentTarget.value)}
                disabled={isDisabled}
                placeholder="Confirm password"
                style={{
                  width: '100%',
                  padding: '14px 16px',
                  background: 'rgba(0, 0, 0, 0.3)',
                  border: '1px solid rgba(87, 166, 78, 0.3)',
                  borderRadius: '12px',
                  color: '#e0e0e0',
                  fontSize: '1rem',
                  outline: 'none',
                  transition: 'all 0.2s ease',
                  opacity: isDisabled ? 0.6 : 1,
                }}
                onFocus={(e) => {
                  if (!isDisabled) {
                    e.currentTarget.style.borderColor = 'rgba(87, 166, 78, 0.6)';
                    e.currentTarget.style.background = 'rgba(0, 0, 0, 0.4)';
                  }
                }}
                onBlur={(e) => {
                  e.currentTarget.style.borderColor = 'rgba(87, 166, 78, 0.3)';
                  e.currentTarget.style.background = 'rgba(0, 0, 0, 0.3)';
                }}
              />
            </div>
          )}

          {/* Error message */}
          {error && (
            <div style={{
              marginBottom: '20px',
              padding: '12px 16px',
              background: 'rgba(255, 107, 107, 0.15)',
              border: '1px solid rgba(255, 107, 107, 0.3)',
              borderRadius: '12px',
              color: '#ff6b6b',
              fontSize: '0.875rem',
              fontWeight: '500',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
            }}>
              <span>⚠️</span>
              {error}
            </div>
          )}

          {/* Submit button */}
          <button
            type="submit"
            disabled={isDisabled}
            style={{
              width: '100%',
              padding: '16px',
              background: isDisabled 
                ? 'rgba(87, 166, 78, 0.3)'
                : 'linear-gradient(135deg, #55FF55 0%, #57A64E 100%)',
              color: isDisabled ? '#666' : '#0a1612',
              border: 'none',
              borderRadius: '12px',
              fontSize: '1rem',
              fontWeight: '700',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              cursor: isDisabled ? 'not-allowed' : 'pointer',
              transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
              boxShadow: isDisabled 
                ? 'none'
                : '0 8px 24px rgba(85, 255, 85, 0.3)',
              opacity: isDisabled ? 0.6 : 1,
            }}
            onMouseEnter={(e) => {
              if (!isDisabled) {
                e.currentTarget.style.transform = 'translateY(-2px)';
                e.currentTarget.style.boxShadow = '0 12px 32px rgba(85, 255, 85, 0.4)';
              }
            }}
            onMouseLeave={(e) => {
              if (!isDisabled) {
                e.currentTarget.style.transform = 'translateY(0)';
                e.currentTarget.style.boxShadow = '0 8px 24px rgba(85, 255, 85, 0.3)';
              }
            }}
          >
            {isSubmitting ? (
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                <span style={{ animation: 'spin 1s linear infinite' }}>⏳</span>
                {passwordSet ? 'Signing in...' : 'Setting up...'}
              </span>
            ) : (
              passwordSet ? '🔓 Sign In' : '🔒 Set Password'
            )}
          </button>
        </form>

        {/* Password requirements (setup mode only) */}
        {!passwordSet && (
          <div style={{
            marginTop: '24px',
            padding: '16px',
            background: 'rgba(87, 166, 78, 0.1)',
            border: '1px solid rgba(87, 166, 78, 0.2)',
            borderRadius: '12px',
          }}>
            <div style={{
              fontSize: '0.75rem',
              color: '#888',
              marginBottom: '8px',
              fontWeight: '600',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}>
              Password Requirements
            </div>
            <ul style={{
              margin: 0,
              padding: '0 0 0 20px',
              fontSize: '0.875rem',
              color: '#b0b0b0',
              lineHeight: '1.6',
            }}>
              <li>At least 8 characters long</li>
              <li>For control panel access only (not for playing Minecraft)</li>
              <li>Share with anyone who needs control panel access</li>
              <li>Store it securely - recovery not available</li>
            </ul>
          </div>
        )}

        <style>{`
          @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
          }
        `}</style>
      </div>
    </div>
  );
}

