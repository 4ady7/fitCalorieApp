import { useState } from 'react';
import { api } from '../api.js';

export function AuthScreen({ onAuth }) {
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const creating = mode === 'register';

  async function submit(event) {
    event.preventDefault();
    setError('');
    if (creating && password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      const data = await api(creating ? '/api/auth/register' : '/api/auth/login', {
        method: 'POST',
        body: { email, password },
      });
      onAuth(data.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-screen">
      <section className="auth-card">
        <p className="eyebrow">Daily nutrition log</p>
        <h1>FitCalorie</h1>
        <p className="lede">Record what you eat, look up a barcode or a product page, and keep the day’s calories and nutrients.</p>
        <div className="segmented" role="tablist" aria-label="Account">
          <button type="button" aria-selected={!creating} onClick={() => { setMode('login'); setError(''); }}>Log in</button>
          <button type="button" aria-selected={creating} onClick={() => { setMode('register'); setError(''); }}>Create account</button>
        </div>
        <form onSubmit={submit}>
          <label>
            Email
            <input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required />
          </label>
          <label>
            Password
            <input type="password" autoComplete={creating ? 'new-password' : 'current-password'} value={password} onChange={(event) => setPassword(event.target.value)} required minLength={creating ? 8 : undefined} />
          </label>
          {creating && (
            <label>
              Confirm password
              <input type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} required />
            </label>
          )}
          {error && <p className="banner error" role="alert">{error}</p>}
          <button className="primary" type="submit" disabled={busy}>{busy ? 'Please wait…' : creating ? 'Create account' : 'Log in'}</button>
        </form>
      </section>
    </main>
  );
}
