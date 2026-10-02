import { StrictMode, useCallback, useEffect, useMemo, useState } from 'react';
import {
  BarChart3,
  Bell,
  BookOpen,
  CalendarDays,
  Check,
  ChevronDown,
  CircleAlert,
  ClipboardCheck,
  Cloud,
  Download,
  Home,
  Inbox,
  Menu,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  UserRound,
  UsersRound,
  WifiOff,
  X,
} from 'lucide-react';
import { createRoot } from 'react-dom/client';
import { useInstallPrompt, useOnline, useServiceWorker } from './hooks/usePwa';
import { api, API_URL } from './services/api';
import './styles.css';

const VIEW_SLUGS = { 'Visão geral': 'geral', 'Presenças': 'presencas', Turmas: 'turmas', Pessoas: 'pessoas', Calendário: 'calendario', Definições: 'definicoes' };
const SLUG_TO_VIEW = Object.fromEntries(Object.entries(VIEW_SLUGS).map(([view, slug]) => [slug, view]));

function viewFromUrl() {
  const requested = new URLSearchParams(window.location.search).get('vista');
  return SLUG_TO_VIEW[requested] || 'Visão geral';
}

const navItems = [
  { label: 'Visão geral', icon: Home },
  { label: 'Presenças', icon: ClipboardCheck },
  { label: 'Turmas', icon: BookOpen },
  { label: 'Pessoas', icon: UsersRound },
  { label: 'Calendário', icon: CalendarDays },
];

const statIcons = { users: UsersRound, chart: BarChart3, book: BookOpen, sparkles: Sparkles };

const EMPTY_DASHBOARD = { stats: {}, classes: [], members: [], sessions: [], visitors: [] };

function sessionDate(session) {
  const match = String(session.date || session.data || '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const parsed = new Date(session.date || session.data || '');
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function attendanceSeries(sessions, period) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  let points;

  if (period === 'Este mês') {
    points = Array.from({ length: 5 }, (_, index) => ({ label: `${index * 7 + 1}-${Math.min((index + 1) * 7, new Date(year, month + 1, 0).getDate())}`, present: 0, enrolled: 0, sessions: 0 }));
  } else if (period === 'Últimos 3 meses') {
    points = Array.from({ length: 3 }, (_, index) => {
      const date = new Date(year, month - 2 + index, 1);
      const label = new Intl.DateTimeFormat('pt-PT', { month: 'short' }).format(date).replace('.', '');
      return { label, year: date.getFullYear(), month: date.getMonth(), present: 0, enrolled: 0, sessions: 0 };
    });
  } else {
    points = Array.from({ length: month + 1 }, (_, index) => {
      const date = new Date(year, index, 1);
      const label = new Intl.DateTimeFormat('pt-PT', { month: 'short' }).format(date).replace('.', '');
      return { label, year, month: index, present: 0, enrolled: 0, sessions: 0 };
    });
  }

  const todayEnd = new Date(year, month, now.getDate(), 23, 59, 59).getTime();
  sessions.forEach((session) => {
    const date = sessionDate(session);
    if (!date || date.getTime() > todayEnd) return;
    let index = -1;
    
    if (period === 'Este mês' && date.getFullYear() === year && date.getMonth() === month) index = Math.floor((date.getDate() - 1) / 7);
    if (period === 'Últimos 3 meses') index = points.findIndex((point) => point.year === date.getFullYear() && point.month === date.getMonth());
    if (period === 'Este ano' && date.getFullYear() === year) index = date.getMonth();
    if (index < 0 || !points[index]) return;
    const present = Number(session.presencas ?? session.presentes ?? 0);
    const enrolled = Number(session.matriculados ?? session.total_matriculados ?? 0);
    if (!Number.isFinite(present) || !Number.isFinite(enrolled) || enrolled <= 0) return;
    points[index].present += present;
    points[index].enrolled += enrolled;
    points[index].sessions += 1;
  });

  
  const totals = points.reduce((sum, point) => ({ present: sum.present + point.present, enrolled: sum.enrolled + point.enrolled }), { present: 0, enrolled: 0 });
  return {
    points: points.map((point) => ({ ...point, hasData: point.enrolled > 0, value: point.enrolled ? Math.min(100, Math.round((point.present / point.enrolled) * 100)) : 0 })),
    totalSessions: sessions.filter((session) => {
      const date = sessionDate(session);
      if (!date || date.getTime() > todayEnd) return false;
      if (period === 'Este mês') return date.getFullYear() === year && date.getMonth() === month;
      if (period === 'Últimos 3 meses') return points.some((point) => point.year === date.getFullYear() && point.month === date.getMonth());
      return date.getFullYear() === year;
    }).length,
    average: totals.enrolled ? Math.min(100, Math.round((totals.present / totals.enrolled) * 100)) : null,
  };
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Bom dia';
  if (hour < 19) return 'Boa tarde';
  return 'Boa noite';
}

function metricValue(value, fallback) {
  const candidate = value ?? fallback;
  return candidate === null || candidate === undefined || candidate === '' ? '0' : String(candidate);
}

function plural(count, singular, pluralForm) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function relativeTime(timestamp) {
  if (!timestamp) return 'nunca';
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'agora mesmo';
  if (seconds < 3600) return `há ${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `há ${Math.floor(seconds / 3600)} h`;
  return new Intl.DateTimeFormat('pt-PT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp));
}

function initialsOf(name) {
  return String(name || '').split(' ').map((part) => part[0]).slice(0, 2).join('').toUpperCase();
}

const SYNC_COPY = {
  loading: { title: 'A sincronizar', hint: 'A aguardar a API', dot: 'status-loading' },
  live: { title: 'Dados sincronizados', hint: `Ligado a ${API_URL}`, dot: '' },
  error: { title: 'API indisponível', hint: 'Não foi possível carregar os dados', dot: 'status-error' },
};

function App() {
  const [active, setActiveState] = useState(viewFromUrl);
  const online = useOnline();
  const { canInstall, install, dismiss: dismissInstall } = useInstallPrompt();
  const { updateReady, applyUpdate } = useServiceWorker();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [modal, setModal] = useState('');
  const [localVisitors, setLocalVisitors] = useState([]);
  const [attendanceStatus, setAttendanceStatus] = useState({});
  const [period, setPeriod] = useState('Este mês');
  const [notice, setNotice] = useState('');
  const [notificationsEnabled, setNotificationsEnabled] = useState(() => localStorage.getItem('icea-notifications') !== 'false');
  const [dashboard, setDashboard] = useState(EMPTY_DASHBOARD);
  const [sync, setSync] = useState({ status: 'loading', savedAt: 0, error: '' });

  const syncDashboard = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setSync((current) => ({ ...current, status: 'loading', error: '' }));

    try {
      const data = await api.getDashboard();
      setDashboard(data);
      setSync({ status: 'live', savedAt: Date.now(), error: '' });
    } catch (error) {
      setDashboard(EMPTY_DASHBOARD);
      setSync({ status: 'error', savedAt: 0, error: error.message });
    }
  }, []);

  useEffect(() => { syncDashboard(); }, [syncDashboard]);

  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') syncDashboard({ silent: true }); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [syncDashboard]);

  const classes = dashboard.classes ?? [];
  const members = dashboard.members ?? [];
  const sessions = dashboard.sessions ?? [];
  const stats = dashboard.stats ?? {};
  const visitors = [...localVisitors, ...(dashboard.visitors ?? [])];
  const visibleMembers = members.map((person) => ({ ...person, status: attendanceStatus[person.id] || person.status }));
  const isBootLoading = sync.status === 'loading' && !classes.length && !members.length && !sessions.length && !visitors.length;
  const hasNoData = !classes.length && !members.length && !sessions.length && !visitors.length;

  const searchTerm = searchQuery.trim().toLocaleLowerCase('pt-PT');
  const searchResults = useMemo(() => {
    if (!searchTerm) return [];
    const match = (value) => String(value ?? '').toLocaleLowerCase('pt-PT').includes(searchTerm);
    return [
      ...classes.filter((item) => match(item.name)).map((item) => ({ id: item.id, kind: 'Turmas', title: item.name })),
      ...visibleMembers.filter((person) => match(person.name)).map((person) => ({ id: person.id, kind: 'Pessoas', title: person.name })),
      ...visitors.filter((visitor) => match(visitor.name)).map((visitor) => ({ id: visitor.id, kind: 'Pessoas', title: visitor.name })),
    ];
  }, [searchTerm, classes, visibleMembers, visitors]);

  const statCards = useMemo(() => [
    { label: 'Alunos ativos', value: metricValue(stats.alunos, members.length || null), note: members.length ? plural(members.length, 'registo', 'registos') : 'Sem pessoas', tone: 'coral', icon: 'users' },
    { label: 'Presenças confirmadas', value: metricValue(stats.presencas_confirmadas, null), note: sessions.length ? plural(sessions.length, 'sessão registada', 'sessões registadas') : 'Sem sessões', tone: 'sky', icon: 'chart' },
    { label: 'Turmas ativas', value: metricValue(stats.turmas, classes.length || null), note: classes.length ? 'Com lista de pessoas' : 'Sem turmas', tone: 'mint', icon: 'book' },
    { label: 'Visitantes', value: metricValue(stats.visitantes_ativos, visitors.length || null), note: visitors.length ? plural(visitors.length, 'registo', 'registos') : 'Sem visitantes', tone: 'gold', icon: 'sparkles' },
  ], [stats, members.length, sessions.length, classes.length, visitors.length]);

  const getClassName = (classId) => classes.find((item) => item.id === classId)?.name || 'Sem turma';
  const attendance = useMemo(() => attendanceSeries(sessions, period), [sessions, period]);
  const syncCopy = SYNC_COPY[sync.status];
  const toggleNotifications = () => {
    const next = !notificationsEnabled;
    setNotificationsEnabled(next);
    localStorage.setItem('icea-notifications', String(next));
  };

  function setActive(view) {
    setActiveState(view);
    const url = new URL(window.location.href);
    const slug = VIEW_SLUGS[view];
    if (slug === 'geral') url.searchParams.delete('vista');
    else url.searchParams.set('vista', slug);
    window.history.pushState({ view }, '', url);
  }

  useEffect(() => {
    const onPopState = () => setActiveState(viewFromUrl());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  function exportCsv(type) {
    const rows = type === 'Turmas' ? classes : type === 'Pessoas' ? visibleMembers : visitors;
    const headers = type === 'Turmas' ? ['Nome', 'Professor', 'Alunos'] : type === 'Pessoas' ? ['Nome', 'Turma', 'Estado'] : ['Nome', 'Turma', 'Data'];
    const values = rows.map((item) => type === 'Turmas'
      ? [item.name, item.professor_name || '', item.alunos ?? item.students ?? '']
      : type === 'Pessoas'
        ? [item.name, getClassName(item.class_id), item.status || 'Registado']
        : [item.name, item.className || 'Visitante', item.date || '']);
    const csv = [headers, ...values].map((row) => row.map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`).join(';')).join('\n');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' }));
    link.download = `${type.toLocaleLowerCase('pt-PT')}-icea.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
    setNotice(`Ficheiro de ${type.toLocaleLowerCase('pt-PT')} exportado.`);
  }

  function saveAttendance(classId, selectedIds) {
    const updates = Object.fromEntries(visibleMembers.filter((person) => person.class_id === classId).map((person) => [person.id, selectedIds.includes(person.id) ? 'Presente' : 'Ausente']));
    setAttendanceStatus((current) => ({ ...current, ...updates }));
    setModal('');
    setNotice('Presenças aplicadas nesta sessão. A API ainda não disponibiliza gravação.');
  }

  function saveVisitor(visitor) {
    setLocalVisitors((current) => [{ ...visitor, id: `local-${Date.now()}`, initials: initialsOf(visitor.name), date: 'Agora' }, ...current]);
    setModal('');
    setNotice('Visitante adicionado nesta sessão. A API ainda não disponibiliza gravação.');
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`}>
<div className="brand-lockup">
          <div><strong>ICEA</strong><small>Comunidade viva</small></div>
          <button className="icon-button close-menu" onClick={() => setMobileOpen(false)} aria-label="Fechar menu"><X size={19} /></button>
        </div>

        <nav className="main-nav" aria-label="Navegação principal">
          <span className="nav-label">Menu principal</span>
          {navItems.map(({ label, icon: Icon }) => (
            <button key={label} className={`nav-item ${active === label ? 'active' : ''}`} onClick={() => { setActive(label); setMobileOpen(false); }}>
              <Icon size={19} strokeWidth={active === label ? 2.4 : 1.8} /><span>{label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className={`sync-card ${sync.status === 'error' ? 'sync-error' : ''}`}>
            <div className="sync-icon">{sync.status === 'loading' ? <RefreshCw size={17} className="spin" /> : <Cloud size={17} />}</div>
            <div><strong>{syncCopy.title}</strong><small>{syncCopy.hint}</small></div>
            <span className={`status-dot ${syncCopy.dot}`} />
          </div>
          {sync.status !== 'live' && <button className="nav-item sync-retry" onClick={() => syncDashboard()}><RefreshCw size={16} /><span>Tentar novamente</span></button>}
          <button className={`nav-item ${active === 'Definições' ? 'active' : ''}`} onClick={() => { setActive('Definições'); setMobileOpen(false); }}><Settings size={19} /><span>Definições</span></button>
          <button className="profile-mini" onClick={() => setModal('profile')}><div className="avatar avatar-profile"><UserRound size={16} /></div><div><strong>Utilizador</strong><small>Sem sessão iniciada</small></div><MoreHorizontal size={18} /></button>
        </div>
      </aside>

      {mobileOpen && <button className="sidebar-overlay" aria-label="Fechar menu" onClick={() => setMobileOpen(false)} />}

      <main className="main-content">
        <header className="topbar">
          <button className="icon-button menu-trigger" onClick={() => setMobileOpen(true)} aria-label="Abrir menu"><Menu size={21} /></button>
          <div className="breadcrumbs"><span>ICEA</span><i>/</i><strong>{active}</strong></div>
          <div className="topbar-actions">
            <div className={`search-wrap ${searchOpen ? 'search-visible' : ''}`}><Search size={18} /><input autoFocus={searchOpen} value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Pesquisar..." aria-label="Pesquisar" /></div>
            <button className="icon-button search-trigger" onClick={() => setSearchOpen((open) => !open)} aria-label="Pesquisar"><Search size={19} /></button>
            <button className="icon-button notification-button" onClick={() => setModal('notifications')} aria-label="Notificações"><Bell size={19} />{notificationsEnabled && <span />}</button>
            <div className="top-avatar"><UserRound size={15} /></div>
          </div>
        </header>

        <div className="page-content">
          <section className="welcome-row">
            <div>
              <div className="eyebrow"><span className="eyebrow-line" /> {new Intl.DateTimeFormat('pt-PT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date())}</div>
              <h1>{greeting()} <span>✦</span></h1>
              <p>Acompanhe o que está a acontecer na sua comunidade.</p>
            </div>
            <div className="welcome-actions">
              <button className="outline-button refresh-button" onClick={() => syncDashboard()} disabled={sync.status === 'loading'}><RefreshCw size={16} /> Sincronizar</button>
              <button className="primary-button" onClick={() => setModal('attendance')} disabled={!members.length}><Plus size={18} /> Registar presença</button>
            </div>
          </section>

          {notice && <div className="notice-banner" role="status"><Check size={16} />{notice}<button className="notice-close" onClick={() => setNotice('')} aria-label="Fechar aviso"><X size={15} /></button></div>}

          {sync.status === 'error' && <div className="api-alert" role="alert"><CircleAlert size={17} /><span><strong>Não foi possível carregar os dados.</strong> {sync.error} A API pode estar a iniciar; tente sincronizar novamente dentro de alguns segundos.</span><button className="icon-button" onClick={() => syncDashboard()} aria-label="Tentar novamente"><RefreshCw size={17} /></button></div>}

          {searchTerm && <section className="search-results" aria-label="Resultados da pesquisa"><div className="panel-heading"><h2>Resultados da pesquisa</h2><button className="icon-button" onClick={() => setSearchQuery('')} aria-label="Limpar pesquisa"><X size={17} /></button></div>{searchResults.length ? searchResults.slice(0, 8).map((result) => <button className="search-result" key={`${result.kind}-${result.id}`} onClick={() => { setActive(result.kind); setSearchQuery(''); }}>{result.title}<span>{result.kind}</span></button>) : <p>Não foram encontrados resultados.</p>}</section>}

          {isBootLoading ? <DashboardSkeleton /> : active === 'Visão geral' ? <>
          <section className="stats-grid" aria-label="Resumo da comunidade">
            {statCards.map((stat) => {
              const Icon = statIcons[stat.icon];
              return <article className="stat-card" key={stat.label}><div className={`stat-icon ${stat.tone}`}><Icon size={19} /></div><div className="stat-copy"><span>{stat.label}</span><strong>{stat.value}</strong><small className={stat.tone === 'coral' || stat.tone === 'sky' ? 'positive' : ''}>{stat.note}</small></div></article>;
            })}
          </section>

          <section className="content-grid">
            <div className="panel attendance-panel">
              <div className="panel-heading"><div><span className="section-kicker">Acompanhamento</span><h2>Presença nas turmas</h2></div><select className="select-button" value={period} onChange={(event) => setPeriod(event.target.value)} aria-label="Período do gráfico"><option>Este mês</option><option>Últimos 3 meses</option><option>Este ano</option></select></div>
              <div className="attendance-chart"><div className="chart-y"><span>100%</span><span>75%</span><span>50%</span><span>25%</span><span>0%</span></div><div className="chart-area"><div className="grid-lines"><i /><i /><i /><i /><i /></div>{attendance.average === null ? <div className="chart-empty">{attendance.totalSessions ? 'Há sessões, mas faltam matrículas para calcular a presença.' : 'Sem sessões registadas neste período.'}</div> : <div className="bars">{attendance.points.map((point) => <div className={`bar-group ${point.hasData ? '' : 'bar-no-data'}`} key={point.label}><div className="bar" style={{ height: `${point.value}%` }}><span>{point.value}%</span></div><small>{point.label}</small></div>)}</div>}</div></div>
              <div className="chart-legend"><span><i className="legend-dot blue-dot" />{attendance.average === null ? 'Sem dados de presença' : `Média real: ${attendance.average}% · ${period}`}</span><button className="text-button" onClick={() => setActive('Presenças')}>Abrir presenças <span>↗</span></button></div>
            </div>

            <div className="panel classes-panel">
              <div className="panel-heading"><div><span className="section-kicker">Organização</span><h2>Turmas ativas</h2></div><button className="text-button" onClick={() => setActive('Turmas')}>Ver todas <span>↗</span></button></div>
              {classes.length ? <div className="class-list">{classes.slice(0, 4).map((item, index) => { const professor = item.equipa?.Professor?.[0]; return <div className="class-row" key={item.id}><div className={`class-badge ${item.color || ['coral', 'sky', 'gold', 'mint'][index % 4]}`}><BookOpen size={17} /></div><div className="class-info"><strong>{item.name}</strong><small>{item.age_min != null && item.age_max != null ? `${item.age_min}–${item.age_max} anos` : 'Faixa etária não indicada'} <i /> {item.professor_name || professor?.nome || 'Equipa por consultar'}</small></div><div className="class-stat"><strong>{item.attendance != null ? `${item.attendance}%` : item.alunos ?? item.students ?? 0}</strong><small>{item.attendance != null ? 'presença' : 'alunos'}</small></div><ChevronDown size={16} className="row-chevron" /></div>; })}</div> : <EmptyState icon={BookOpen} title="Sem turmas recebidas" hint="A API ainda não devolveu turmas." />}
            </div>
          </section>

          <section className="bottom-grid">
            <div className="panel people-panel"><div className="panel-heading"><div><span className="section-kicker">Últimos registos</span><h2>Pessoas recentes</h2></div><button className="icon-button" onClick={() => exportCsv('Pessoas')} disabled={!visibleMembers.length} aria-label="Exportar pessoas"><Download size={17} /></button></div>{visibleMembers.length ? <div className="people-table"><div className="table-head"><span>Pessoa</span><span>Turma</span><span>Estado</span></div>{visibleMembers.slice(0, 4).map((person) => <div className="person-row" key={person.id}><div className="person-name"><div className="avatar">{person.initials || initialsOf(person.name)}</div><strong>{person.name}</strong></div><span>{getClassName(person.class_id)}</span><span className={`presence ${person.status === 'Ausente' ? 'absent' : person.status === 'Presente' ? 'present' : 'unknown'}`}><i />{person.status || 'Sem estado'}</span></div>)}</div> : <EmptyState icon={UsersRound} title="Sem pessoas registadas" hint="A API ainda não devolveu membros." />}</div>
            <div className="panel visitors-panel"><div className="panel-heading"><div><span className="section-kicker">Acolhimento</span><h2>Visitantes recentes</h2></div><button className="text-button" onClick={() => setActive('Pessoas')}>Ver todos <span>↗</span></button></div>{visitors.length ? <div className="visitor-list">{visitors.slice(0, 3).map((visitor) => <div className="visitor-row" key={visitor.id}><div className="avatar visitor-avatar">{visitor.initials || initialsOf(visitor.name)}</div><div><strong>{visitor.name}</strong><small>{visitor.className || 'Visitante'}</small></div><time>{visitor.date || 'Data indisponível'}</time></div>)}</div> : <EmptyState icon={Sparkles} title="Sem visitantes registados" hint="Os visitantes aparecem aqui depois de uma sessão." />}<button className="outline-button" onClick={() => setModal('visitor')}><Plus size={16} /> Adicionar visitante</button></div>
          </section>
          </> : hasNoData ? <EmptyState icon={Inbox} title="Ainda não há dados" hint="Sincronize com a API para carregar os dados da comunidade." /> : <WorkspacePage active={active} classes={classes} members={visibleMembers} visitors={visitors} sessions={sessions} getClassName={getClassName} onExport={exportCsv} onAttendance={() => setModal('attendance')} onAddVisitor={() => setModal('visitor')} sync={sync} onSync={() => syncDashboard()} notificationsEnabled={notificationsEnabled} onToggleNotifications={toggleNotifications} />}
        </div>
      </main>
      {modal && <ActionDialog type={modal} classes={classes} members={visibleMembers} sessions={sessions} onClose={() => setModal('')} onSaveAttendance={saveAttendance} onSaveVisitor={saveVisitor} notificationsEnabled={notificationsEnabled} onToggleNotifications={toggleNotifications} />}

      <PwaBar online={online} canInstall={canInstall} onInstall={install} onDismissInstall={dismissInstall} updateReady={updateReady} onApplyUpdate={applyUpdate} />
    </div>
  );
}

function PwaBar({ online, canInstall, onInstall, onDismissInstall, updateReady, onApplyUpdate }) {
  if (online && !canInstall && !updateReady) return null;

  return <div className="pwa-stack">
    {!online && <div className="pwa-card pwa-offline" role="status"><WifiOff size={17} /><span>Sem ligação à internet. Os dados dependem da API.</span></div>}
    {updateReady && <div className="pwa-card pwa-update" role="status"><RefreshCw size={17} /><span>Está disponível uma nova versão da aplicação.</span><button className="pwa-action" onClick={onApplyUpdate}>Actualizar agora</button></div>}
    {canInstall && <div className="pwa-card pwa-install" role="status"><img className="pwa-logo" src="/faviconICEA/web-app-manifest-192x192.png" alt="" width="38" height="38" /><div className="pwa-copy"><strong>Instalar a aplicação</strong><span>Abre directamente no telemóvel, sem barra de browser.</span></div><button className="pwa-action" onClick={onInstall}>Instalar</button><button className="icon-button" onClick={onDismissInstall} aria-label="Fechar aviso de instalação"><X size={16} /></button></div>}
  </div>;
}

function EmptyState({ icon: Icon = Inbox, title, hint }) {
  return <div className="empty-state"><Icon size={24} /><strong>{title}</strong>{hint && <span>{hint}</span>}</div>;
}

function DashboardSkeleton() {
  return <div className="skeleton-wrap" aria-busy="true" aria-label="A carregar dados">
    <section className="stats-grid">{Array.from({ length: 4 }, (_, index) => <article className="stat-card" key={index}><div className="skeleton skeleton-icon" /><div className="skeleton-lines"><span className="skeleton" style={{ width: '58%' }} /><span className="skeleton" style={{ width: '38%', height: 24 }} /><span className="skeleton" style={{ width: '44%' }} /></div></article>)}</section>
    <section className="content-grid"><div className="panel"><span className="skeleton" style={{ width: 180, height: 16 }} /><div className="skeleton skeleton-chart" /></div><div className="panel"><span className="skeleton" style={{ width: 140, height: 16 }} />{Array.from({ length: 4 }, (_, index) => <div className="skeleton" style={{ height: 44, marginTop: 14 }} key={index} />)}</div></section>
  </div>;
}

function WorkspacePage({ active, classes, members, visitors, sessions, getClassName, onExport, onAttendance, onAddVisitor, sync, onSync, notificationsEnabled, onToggleNotifications }) {
  if (active === 'Turmas') return <section className="workspace-view"><div className="workspace-heading"><div><span className="section-kicker">Organização</span><h1>Turmas</h1><p>{classes.length ? plural(classes.length, 'turma disponível', 'turmas disponíveis') : 'Sem dados recebidos'}</p></div><button className="outline-button export-button" onClick={() => onExport('Turmas')} disabled={!classes.length}><Download size={16} /> Exportar CSV</button></div>{classes.length ? <div className="workspace-list">{classes.map((item, index) => <article className="workspace-row" key={item.id}><div className={`class-badge ${item.color || ['coral', 'sky', 'gold', 'mint'][index % 4]}`}><BookOpen size={17} /></div><div className="workspace-row-copy"><strong>{item.name}</strong><small>{item.age_min != null && item.age_max != null ? `${item.age_min}–${item.age_max} anos` : 'Faixa etária não indicada'} · {item.professor_name || item.equipa?.Professor?.[0]?.nome || 'Equipa por consultar'}</small></div><span>{item.alunos ?? item.students ?? 0} alunos</span></article>)}</div> : <EmptyState icon={BookOpen} title="Sem turmas" hint="A API não devolveu turmas." />}</section>;

  if (active === 'Pessoas') return <section className="workspace-view"><div className="workspace-heading"><div><span className="section-kicker">Comunidade</span><h1>Pessoas</h1><p>{members.length || visitors.length ? `${plural(members.length, 'pessoa registada', 'pessoas registadas')} e ${plural(visitors.length, 'visitante', 'visitantes')}` : 'Sem dados recebidos'}</p></div><div className="workspace-actions"><button className="outline-button export-button" onClick={() => onExport('Pessoas')} disabled={!members.length}><Download size={16} /> Exportar</button><button className="primary-button" onClick={onAddVisitor}><Plus size={16} /> Visitante</button></div></div>{members.length ? <div className="panel workspace-table"><div className="workspace-table-head"><span>Nome</span><span>Turma</span><span>Estado</span></div>{members.map((person) => <div className="workspace-table-row" key={person.id}><strong>{person.name}</strong><span>{getClassName(person.class_id)}</span><span className={`presence ${person.status === 'Ausente' ? 'absent' : person.status === 'Presente' ? 'present' : 'unknown'}`}><i />{person.status || 'Sem estado'}</span></div>)}</div> : <EmptyState icon={UsersRound} title="Sem pessoas registadas" hint="A API não devolveu membros." />}<h2 className="workspace-subheading">Visitantes</h2>{visitors.length ? <div className="panel workspace-table">{visitors.map((visitor) => <div className="workspace-table-row visitor-table-row" key={visitor.id}><strong>{visitor.name}</strong><span>{visitor.className || 'Visitante'}</span><span>{visitor.date || 'Data indisponível'}</span></div>)}</div> : <EmptyState icon={Sparkles} title="Sem visitantes" hint="A API não devolveu visitantes." />}</section>;

  if (active === 'Presenças') return <section className="workspace-view"><div className="workspace-heading"><div><span className="section-kicker">Acompanhamento</span><h1>Presenças</h1><p>Estado atual das pessoas por turma</p></div><button className="primary-button" onClick={onAttendance} disabled={!members.length}><Plus size={16} /> Registar presença</button></div>{classes.length && members.length ? classes.map((item) => <section className="panel attendance-class" key={item.id}><div className="panel-heading"><div><span className="section-kicker">Turma</span><h2>{item.name}</h2></div><span className="attendance-count">{members.filter((person) => person.class_id === item.id && person.status === 'Presente').length}/{members.filter((person) => person.class_id === item.id).length} presentes</span></div>{members.filter((person) => person.class_id === item.id).map((person) => <div className="attendance-person" key={person.id}><div className="avatar">{person.initials || initialsOf(person.name)}</div><strong>{person.name}</strong><span className={`presence ${person.status === 'Ausente' ? 'absent' : person.status === 'Presente' ? 'present' : 'unknown'}`}><i />{person.status || 'Sem estado'}</span></div>)}</section>) : <EmptyState icon={BookOpen} title="Sem dados de presença" hint="São necessárias turmas e pessoas para listar as presenças." />}</section>;

  if (active === 'Calendário') return <section className="workspace-view"><div className="workspace-heading"><div><span className="section-kicker">Agenda</span><h1>Calendário</h1><p>{sessions.length ? plural(sessions.length, 'sessão recebida', 'sessões recebidas') : 'Sem dados recebidos'}</p></div></div>{sessions.length ? <div className="workspace-list">{sessions.map((session, index) => <article className="workspace-row" key={session.id || index}><div className="class-badge sky"><CalendarDays size={17} /></div><div className="workspace-row-copy"><strong>{session.name || session.turma || session.class_name || `Sessão ${index + 1}`}</strong><small>{session.date || session.data || session.start || 'Data não indicada'}</small></div><span>{session.time || session.hora || ''}</span></article>)}</div> : <EmptyState icon={CalendarDays} title="Sem sessões para apresentar" hint="A API não devolveu sessões para o calendário." />}</section>;

  return <section className="workspace-view"><div className="workspace-heading"><div><span className="section-kicker">Aplicação</span><h1>Definições</h1><p>Preferências e estado dos dados</p></div></div><div className="panel settings-list"><div className="setting-row"><span><strong>Origem dos dados</strong><small>{API_URL}</small></span><span className={`setting-status ${sync.status === 'live' ? '' : 'setting-status-warn'}`}>{sync.status === 'live' ? 'API ligada' : sync.status === 'loading' ? 'A sincronizar' : 'Desligada'}</span></div><div className="setting-row"><span><strong>Última sincronização</strong><small>{sync.savedAt ? relativeTime(sync.savedAt) : 'Nunca houve sincronização'}</small></span><button className="outline-button export-button" onClick={onSync} disabled={sync.status === 'loading'}><RefreshCw size={16} /> Sincronizar</button></div><div className="setting-row"><span><strong>Exportação</strong><small>Descarregar listagens de turmas e pessoas</small></span><button className="outline-button export-button" onClick={() => onExport('Turmas')} disabled={!classes.length}><Download size={16} /> Exportar turmas</button></div><div className="setting-row"><span><strong>Notificações</strong><small>Mostrar o indicador de notificações na barra superior</small></span><input type="checkbox" checked={notificationsEnabled} onChange={onToggleNotifications} /></div><div className="setting-row"><span><strong>Conta</strong><small>A autenticação ainda não está ligada</small></span><span className="setting-status setting-status-warn">Sem sessão</span></div></div></section>;
}

function ActionDialog({ type, classes, members, onClose, onSaveAttendance, onSaveVisitor, notificationsEnabled, onToggleNotifications }) {
  const [selectedClass, setSelectedClass] = useState(classes[0]?.id ?? '');
  const [selectedMembers, setSelectedMembers] = useState([]);
  const classMembers = members.filter((person) => person.class_id === selectedClass);

  useEffect(() => {
    setSelectedMembers(members.filter((person) => person.class_id === selectedClass && person.status === 'Presente').map((person) => person.id));
  }, [selectedClass]);

  function submitAttendance(event) {
    event.preventDefault();
    onSaveAttendance(selectedClass, selectedMembers);
  }

  function submitVisitor(event) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    onSaveVisitor({ name: String(formData.get('name') || '').trim(), className: String(formData.get('className') || 'Visitante') });
  }

  const titleMap = { attendance: 'Registar presenças', visitor: 'Adicionar visitante', notifications: 'Notificações', profile: 'Perfil' };

  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="action-dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><div className="dialog-heading"><h2 id="dialog-title">{titleMap[type] ?? 'Diálogo'}</h2><button className="icon-button" onClick={onClose} aria-label="Fechar"><X size={18} /></button></div>
    {type === 'attendance' && <form onSubmit={submitAttendance}><label className="form-field">Turma<select value={selectedClass} onChange={(event) => setSelectedClass(event.target.value)}>{classes.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>{classMembers.length ? <div className="attendance-checklist">{classMembers.map((person) => <label className="check-row" key={person.id}><input type="checkbox" checked={selectedMembers.includes(person.id)} onChange={(event) => setSelectedMembers((current) => event.target.checked ? [...current, person.id] : current.filter((id) => id !== person.id))} /><span>{person.name}</span></label>)}</div> : <p className="dialog-note">Esta turma não tem pessoas registadas.</p>}<p className="dialog-note">Esta alteração vale apenas para esta sessão. A API ainda não disponibiliza gravação de presenças.</p><button className="primary-button dialog-submit" type="submit" disabled={!classMembers.length}><Check size={16} /> Aplicar presenças</button></form>}
    {type === 'visitor' && <form onSubmit={submitVisitor}><label className="form-field">Nome<input name="name" required autoFocus placeholder="Nome completo" /></label><label className="form-field">Turma de acolhimento<select name="className"><option value="Visitante">Sem turma</option>{classes.map((item) => <option key={item.id} value={item.name}>{item.name}</option>)}</select></label><p className="dialog-note">O visitante fica visível apenas nesta sessão. A API ainda não disponibiliza gravação de novos registos.</p><button className="primary-button dialog-submit" type="submit"><Plus size={16} /> Adicionar visitante</button></form>}
    {type === 'notifications' && <div className="dialog-copy"><p>O indicador de notificações está {notificationsEnabled ? 'ativo' : 'inativo'} nas definições locais.</p><button className="outline-button" onClick={onToggleNotifications}>{notificationsEnabled ? 'Desativar' : 'Ativar'} notificações</button></div>}
    {type === 'profile' && <div className="dialog-copy"><div className="profile-dialog-avatar"><UserRound size={22} /></div><strong>Sem sessão iniciada</strong><p>A autenticação ainda não está ligada a esta instalação. O acesso dos utilizadores chega com a próxima fase.</p><button className="outline-button" onClick={onClose}>Fechar</button></div>}
  </section></div>;
}

createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);