import React, { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { App } from './App.jsx';
import { isPrintingDepartment, printingDepartments, printingPinDigits, printingPinLength } from './printing-departments.mjs';

const accessUrl = '/api/printing-access';
const accessChangeKey = 'ritm-printing-session-change';
const themeKey = 'ritm-printing-theme';

function darkThemeSaved() {
  try { return localStorage.getItem(themeKey) === 'dark'; } catch { return false; }
}

function notifyOtherTabs() {
  try { localStorage.setItem(accessChangeKey,crypto.randomUUID()); } catch { /* The next request checks the session. */ }
}

async function requestAccess(payload, signal) {
  const response = await fetch(accessUrl,payload ? {
    method:'POST',signal,headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),
  } : {signal});
  const value = await response.json().catch(() => null);
  if (!response.ok || !value) throw Object.assign(new Error(value?.message || 'Сервер входа недоступен.'),{status:response.status});
  return value;
}

function PinField({label,name,initial = false}) {
  return <label>{label}<input type="password" name={name} inputMode="numeric" autoComplete={initial ? 'new-password' : 'current-password'}
    required minLength={printingPinLength} maxLength={printingPinLength} pattern={printingPinDigits} title="Четыре цифры"/></label>;
}

export function PrintingAccess() {
  const section = window.location.pathname.replace(/^\/|\/$/g,'');
  const department = isPrintingDepartment(section) ? section : null;
  const [access,setAccess] = useState(null);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [workspaceError,setWorkspaceError] = useState('');
  const [reload,setReload] = useState(0);
  const [dark,setDark] = useState(darkThemeSaved);
  useLayoutEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; },[dark]);

  useEffect(() => {
    function syncTheme(event) {
      if (event.key === themeKey || event.key == null) setDark(darkThemeSaved());
    }
    window.addEventListener('storage',syncTheme);
    return () => window.removeEventListener('storage',syncTheme);
  },[]);

  function toggleTheme() {
    const next = !dark;
    setDark(next);
    try { localStorage.setItem(themeKey,next ? 'dark' : 'light'); } catch { /* Keep the current tab's theme. */ }
  }

  useEffect(() => {
    const controller = new AbortController();
    requestAccess(null,controller.signal).then(setAccess).catch(failure => {
      if (!controller.signal.aborted) setError(failure.message);
    });
    return () => controller.abort();
  },[reload]);

  useEffect(() => {
    function sync(event) {
      if (event.type === 'pageshow' ? event.persisted : event.key === accessChangeKey) setReload(value => value+1);
    }
    window.addEventListener('storage',sync);
    window.addEventListener('pageshow',sync);
    return () => {
      window.removeEventListener('storage',sync);
      window.removeEventListener('pageshow',sync);
    };
  },[]);

  const expire = useCallback(() => {
    setAccess(current => ({...current,department:null,expiresAt:null}));
    setError('Сеанс завершён. Введите PIN ещё раз.');
  },[]);

  const expiresAt = access?.department === department ? access?.expiresAt : null;
  useEffect(() => {
    if (!expiresAt) return;
    const timer = setTimeout(expire,Math.max(0,expiresAt-Date.now()));
    return () => clearTimeout(timer);
  },[expiresAt,expire]);

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    setError('');
    let payload = {action:'login',department,pin:values.get('pin')};
    if (!access.configured) {
      const roll = values.get('roll');
      const box = values.get('box');
      if (roll !== values.get('roll-confirm') || box !== values.get('box-confirm')) {
        setError('PIN и подтверждение должны совпадать для каждого участка.');
        return;
      }
      if (roll === box) {
        setError('Для рулонов и бокса нужны разные PIN.');
        return;
      }
      payload = {action:'setup',roll,box};
    }
    setBusy(true);
    try {
      const result = await requestAccess(payload);
      form.reset();
      setAccess(result);
      notifyOtherTabs();
    } catch (failure) {
      if (failure.status === 409) setReload(value => value+1);
      if (payload.action === 'login') form.reset();
      setError(failure.message || 'Не удалось выполнить вход.');
    } finally { setBusy(false); }
  }

  async function logout() {
    if (busy) return;
    setBusy(true);
    setWorkspaceError('');
    try {
      await requestAccess({action:'logout'});
      notifyOtherTabs();
      window.location.assign('/');
    } catch (failure) {
      setWorkspaceError(failure.message || 'Не удалось выйти. Повторите попытку.');
      setBusy(false);
    }
  }

  const themeControl = <button className="outline theme-toggle" type="button" aria-pressed={dark} onClick={toggleTheme}>
    <span className="theme-symbol" aria-hidden="true">{dark ? '☀' : '☾'}</span> Тёмная тема
  </button>;
  if (department && access?.department === department) {
    return <App key={department} department={department} onSessionExpired={expire} onLogout={logout}
      loggingOut={busy} accessError={workspaceError} themeControl={themeControl}/>;
  }

  return <main className="access-screen">
    <div className="access-heading"><div className="brand"><b>RITM /</b> Печать</div>{themeControl}</div>
    {!access ? <>
      <h1>Вход в печать</h1>
      {!error && <p role="status">Проверяем настройки входа…</p>}
      {error && <button className="outline" type="button" onClick={() => { setError('');setReload(value => value+1); }}>Повторить</button>}
    </> : !access.configured ? <>
      <h1>Настройте вход</h1>
      <p className="quiet">Задайте отдельный PIN из четырёх цифр для каждого участка.</p>
      <form className="access-form" onSubmit={submit}>
        <fieldset disabled={busy}>
          {Object.entries(printingDepartments).map(([key,label]) => <section key={key} aria-labelledby={'pin-'+key}>
            <h2 id={'pin-'+key}>{label}</h2>
            <div className="pin-pair">
              <PinField name={key} label="Новый PIN" initial/>
              <PinField name={key+'-confirm'} label="Повторите PIN" initial/>
            </div>
          </section>)}
          <button className="primary" type="submit">{busy ? 'Сохраняем…' : 'Сохранить PIN'}</button>
        </fieldset>
      </form>
    </> : department ? <>
      <a className="access-back" href="/">К выбору участка</a>
      <h1>{printingDepartments[department]}</h1>
      <form className="access-form" onSubmit={submit}>
        <fieldset disabled={busy}>
          <PinField name="pin" label="PIN участка"/>
          <button className="primary" type="submit">{busy ? 'Проверяем…' : 'Войти'}</button>
        </fieldset>
      </form>
    </> : <>
      <h1>Выберите участок</h1>
      <nav className="access-choices" aria-label="Вход по участкам">
        {Object.entries(printingDepartments).map(([key,label]) => <a className="outline" key={key} href={'/'+key}>{label}</a>)}
      </nav>
    </>}
    {error && <p className="notice error" role="alert">{error}</p>}
  </main>;
}
