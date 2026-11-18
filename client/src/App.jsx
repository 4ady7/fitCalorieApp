import { useEffect, useState } from 'react';
import { assertDate, todayISO } from '@shared/nutrients.js';
import { api } from './api.js';
import { AuthScreen } from './components/AuthScreen.jsx';
import { Dashboard } from './components/Dashboard.jsx';
import { AddFood } from './components/AddFood.jsx';

function dateFromLocation() {
  const requested = new URLSearchParams(window.location.search).get('date');
  if (!requested) return todayISO();
  try {
    return assertDate(requested);
  } catch {
    return todayISO();
  }
}

function rememberDate(next) {
  const url = new URL(window.location.href);
  if (next === todayISO()) url.searchParams.delete('date');
  else url.searchParams.set('date', next);
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
}

export function App() {
  const [user, setUser] = useState(undefined);
  const [date, setDate] = useState(dateFromLocation);
  const [day, setDay] = useState(null);
  const [aiConfigured, setAiConfigured] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    api('/api/auth/me')
      .then((data) => setUser(data.user))
      .catch((err) => {
        setUser(null);
        if (err.status !== 401) setError(err.message);
      });
    api('/api/health')
      .then((data) => setAiConfigured(Boolean(data.aiConfigured)))
      .catch(() => setAiConfigured(false));
  }, []);

  useEffect(() => {
    if (!user) return undefined;
    let cancelled = false;
    api(`/api/days/${date}`)
      .then((data) => {
        if (!cancelled) {
          setDay(data);
          setError('');
        }
      })
      .catch((err) => {
        if (err.status === 401) setUser(null);
        else if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [user, date]);

  function chooseDate(next) {
    rememberDate(next);
    setDate(next);
    setNotice('');
  }

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' });
    setUser(null);
    setDay(null);
    setNotice('');
    setAdding(false);
  }

  if (user === undefined) {
    return <main className="auth-screen"><p className="banner">Loading FitCalorie…</p></main>;
  }
  if (!user) return <AuthScreen onAuth={(next) => { setUser(next); setError(''); setNotice(''); }} />;

  return (
    <>
      <Dashboard
        user={user}
        date={date}
        day={day}
        notice={notice}
        error={error}
        aiConfigured={aiConfigured}
        onDate={chooseDate}
        onDay={setDay}
        onNotice={setNotice}
        onLogout={logout}
        onAdd={() => setAdding(true)}
      />
      {adding && (
        <AddFood
          date={date}
          isToday={date === todayISO()}
          aiConfigured={aiConfigured}
          onClose={() => setAdding(false)}
          onAdded={(nextDay, message) => {
            setDay(nextDay);
            setNotice(message);
            setAdding(false);
            setError('');
          }}
        />
      )}
    </>
  );
}
