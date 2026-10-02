import { useState } from 'react';
import { registerWithEmail, signInWithEmail, signInWithGoogle } from './services/firebase';

function authErrorMessage(error) {
  const messages = {
    'auth/email-already-in-use': 'Este email já tem uma conta.',
    'auth/invalid-credential': 'Email ou palavra-passe incorretos.',
    'auth/invalid-email': 'O email não é válido.',
    'auth/popup-blocked': 'O navegador bloqueou a janela do Google. Permita pop-ups e tente novamente.',
    'auth/popup-closed-by-user': 'A janela de autenticação foi fechada antes de terminar.',
    'auth/weak-password': 'A palavra-passe precisa de pelo menos 6 caracteres.',
  };
  return messages[error?.code] || 'Não foi possível autenticar. Tente novamente.';
}

export default function AuthScreen() {
  const [mode, setMode] = useState('login');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function runAuth(action) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (authError) {
      setError(authErrorMessage(authError));
    } finally {
      setBusy(false);
    }
  }

  async function submit(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') || '').trim();
    const password = String(form.get('password') || '');
    const displayName = String(form.get('displayName') || '').trim();

    await runAuth(() => mode === 'register'
      ? registerWithEmail(displayName, email, password)
      : signInWithEmail(email, password));
  }

  return <main className="auth-shell">
    <section className="auth-panel" aria-labelledby="auth-title">
      <div className="auth-brand"><img src="/faviconICEA/web-app-manifest-192x192.png" alt="" width="48" height="48" /><div><strong>ICEA</strong><span>Comunidade viva</span></div></div>
      <h1 id="auth-title">{mode === 'register' ? 'Criar conta' : 'Bem-vindo de volta'}</h1>
      <p className="auth-lede">Aceda ao painel da comunidade.</p>

      <button className="auth-google" type="button" onClick={() => runAuth(signInWithGoogle)} disabled={busy}>
        <span className="google-mark" aria-hidden="true">G</span> Continuar com Google
      </button>
      <div className="auth-divider"><span>ou com email</span></div>

      <form className="auth-form" onSubmit={submit}>
        {mode === 'register' && <label className="auth-field">Nome<input name="displayName" autoComplete="name" required maxLength={100} /></label>}
        <label className="auth-field">Email<input name="email" type="email" autoComplete="email" required /></label>
        <label className="auth-field">Palavra-passe<input name="password" type="password" autoComplete={mode === 'register' ? 'new-password' : 'current-password'} minLength={6} required /></label>
        {error && <p className="auth-error" role="alert">{error}</p>}
        <button className="primary-button auth-submit" type="submit" disabled={busy}>{busy ? 'A processar...' : mode === 'register' ? 'Criar conta' : 'Entrar'}</button>
      </form>

      <p className="auth-switch">{mode === 'register' ? 'Já tem conta?' : 'Ainda não tem conta?'} <button type="button" onClick={() => { setMode(mode === 'register' ? 'login' : 'register'); setError(''); }} disabled={busy}>{mode === 'register' ? 'Entrar' : 'Criar conta'}</button></p>
    </section>
  </main>;
}