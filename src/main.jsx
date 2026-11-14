import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BarChart3,
  Bell,
  BookOpen,
  Cake,
  CalendarDays,
  Camera,
  Check,
  ChevronDown,
  CircleAlert,
  ClipboardCheck,
  Cloud,
  Download,
  Home,
  Inbox,
  LogOut,
  Menu,
  Moon,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Sun,
  Trash2,
  UserPlus,
  UserRound,
  UsersRound,
  WifiOff,
  X,
} from 'lucide-react';
import { createRoot } from 'react-dom/client';
import AuthScreen from './AuthScreen';
import { useInstallPrompt, useOnline, useServiceWorker } from './hooks/usePwa';
import { api } from './services/api';
import { reduzirFoto } from './services/fotos';
import {
  signOutUser,
  subscribeToAttendanceRecords,
  subscribeToAuthState,
  subscribeToUserProfile,
  subscribeToVisitorRecords,
} from './services/firebase';
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

const EMPTY_DASHBOARD = { stats: {}, classes: [], members: [], sessions: [], visitors: [], attendanceRecords: [] };
const CACHE_KEY = 'icea-dashboard-cache';
const SYNC_INTERVAL_MS = 20000;
const MEMBER_DELETE_ENABLED = import.meta.env.VITE_ENABLE_MEMBER_DELETE !== 'false';
const podeEliminarAluno = (isAdmin) => isAdmin && MEMBER_DELETE_ENABLED;

function dateKey(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${String(iso[2]).padStart(2, '0')}-${String(iso[3]).padStart(2, '0')}`;
  const br = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (br) return `${br[3]}-${String(br[2]).padStart(2, '0')}-${String(br[1]).padStart(2, '0')}`;
  return raw;
}

function dateOnly(value) {
  const key = dateKey(value);
  const match = key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysFromToday(value, today) {
  const date = dateOnly(value);
  if (!date) return null;
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((date - base) / 86400000);
}

function mergeAttendance(apiRecords = [], legacyRecords = []) {
  const merged = new Map();
  const keyOf = (record) => `${record.classId ?? record.class_id ?? ''}|${dateKey(record.sessionDate ?? record.session_date ?? record.date)}`;

  [...apiRecords, ...legacyRecords].forEach((record) => {
    const key = keyOf(record);
    const normalizado = {
      ...record,
      classId: record.classId ?? record.class_id,
      sessionDate: record.sessionDate ?? record.session_date ?? record.date,
    };
    const existente = merged.get(key);
    if (!existente) {
      merged.set(key, { ...normalizado, attendance: [...(record.attendance || [])] });
      return;
    }
    const porMembro = new Map();
    [...(existente.attendance || []), ...(normalizado.attendance || [])].forEach((entry) => {
      if (entry?.memberId) porMembro.set(entry.memberId, entry);
    });
    merged.set(key, { ...existente, ...normalizado, attendance: [...porMembro.values()] });
  });

  return [...merged.values()];
}

function mergeVisitors(apiVisitors = [], legacyVisitors = []) {
  const merged = [];
  const seen = new Set();
  [...apiVisitors, ...legacyVisitors].forEach((visitor) => {
    const key = `${String(visitor.name || '').trim().toLocaleLowerCase('pt-PT')}|${dateKey(visitor.date)}`;
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(visitor);
  });
  return merged;
}

function sessionDate(session) {
  const match = String(session.date || session.data || '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const parsed = new Date(session.date || session.data || '');
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function attendanceSeries(sessions, period, attendanceRecords = [], members = []) {
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

  attendanceRecords.forEach((rec) => {
    const ds = rec.sessionDate || (rec.createdAt?.toDate?.() ? rec.createdAt.toDate().toISOString().slice(0, 10) : '');
    if (!ds) return;
    const date = new Date(ds + 'T00:00:00');
    if (Number.isNaN(date.getTime()) || date.getTime() > todayEnd) return;
    let index = -1;
    if (period === 'Este mês' && date.getFullYear() === year && date.getMonth() === month) index = Math.floor((date.getDate() - 1) / 7);
    if (period === 'Últimos 3 meses') index = points.findIndex((point) => point.year === date.getFullYear() && point.month === date.getMonth());
    if (period === 'Este ano' && date.getFullYear() === year) index = date.getMonth();
    if (index < 0 || !points[index]) return;
    const attendance = rec.attendance || [];
    const present = attendance.filter((a) => a.status === 'Presente').length;
    const enrolled = attendance.length || members.filter((m) => String(m.class_id) === String(rec.classId)).length || 0;
    if (!Number.isFinite(present)) return;
    if (enrolled <= 0 && members.length > 0) return;
    points[index].present += present;
    points[index].enrolled += Math.max(enrolled, present);
    points[index].sessions += 1;
  });

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
    if (points[index].sessions > 0 && points[index].enrolled > 0) return;
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

function formatDatePt(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  if (!y || !m || !d) return iso;
  return `${d}/${m}/${y}`;
}

function formatDateShort(value) {
  const date = dateOnly(value);
  if (!date) return String(value || '—');
  return new Intl.DateTimeFormat('pt-PT', { day: '2-digit', month: '2-digit' }).format(date);
}

function relativeDayLabel(days) {
  if (days === 0) return 'Hoje';
  if (days === 1) return 'Amanhã';
  return `Em ${days} dias`;
}

function hojeIso() {
  const agora = new Date();
  return `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, '0')}-${String(agora.getDate()).padStart(2, '0')}`;
}

function birthdayReminder(member, today = new Date()) {
  const rawBirthDate = member.birth_date || member.birthDate || member.data_nascimento || member.dataNascimento;
  const raw = String(rawBirthDate || '').trim();
  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  const br = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const year = Number(iso?.[1] || br?.[3]);
  const month = Number(iso?.[2] || br?.[2]);
  const day = Number(iso?.[3] || br?.[1]);
  if (!year || !month || !day) return null;
  const recordedBirthDate = new Date(Date.UTC(year, month - 1, day));
  if (recordedBirthDate.getUTCFullYear() !== year || recordedBirthDate.getUTCMonth() !== month - 1 || recordedBirthDate.getUTCDate() !== day) return null;

  const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  let birthdayYear = today.getFullYear();
  let birthdayDay;
  let birthdayUtc;

  do {
    const lastDayOfMonth = new Date(birthdayYear, month, 0).getDate();
    birthdayDay = Math.min(day, lastDayOfMonth);
    birthdayUtc = Date.UTC(birthdayYear, month - 1, birthdayDay);
    if (birthdayUtc < todayUtc) birthdayYear += 1;
  } while (birthdayUtc < todayUtc);

  const daysUntil = Math.round((birthdayUtc - todayUtc) / 86400000);
  if (daysUntil > 30) return null;

  const turningAge = birthdayYear - year;

  return {
    id: member.id,
    name: member.name || member.nome || 'Aluno',
    date: `${String(birthdayDay).padStart(2, '0')}/${String(month).padStart(2, '0')}`,
    daysUntil,
    turningAge: turningAge > 0 ? turningAge : null,
  };
}

const SYNC_COPY = {
  loading: { title: 'A carregar dados', hint: 'Pode demorar alguns instantes.', dot: 'status-loading' },
  live: { title: 'Dados atualizados', hint: 'Informação atualizada.', dot: '' },
  error: { title: 'Não foi possível atualizar', hint: 'Tente novamente daqui a pouco.', dot: 'status-error' },
};

function App() {
  const [authSession, setAuthSession] = useState({ loading: true, user: null, profile: null, error: '' });
  const [active, setActiveState] = useState(viewFromUrl);
  const online = useOnline();
  const { canInstall, install, dismiss: dismissInstall } = useInstallPrompt();
  const { updateReady, applyUpdate } = useServiceWorker();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [theme, setTheme] = useState(() => localStorage.getItem('icea-theme') === 'dark' ? 'dark' : 'light');
  const [modal, setModal] = useState('');
  const [confirmarEliminacao, setConfirmarEliminacao] = useState(null);
  const [fotos, setFotos] = useState({});
  const [fotosCarregadas, setFotosCarregadas] = useState(false);
  const [alvoFoto, setAlvoFoto] = useState(null);
  const [legacyVisitorRecords, setLegacyVisitorRecords] = useState([]);
  const [legacyAttendanceRecords, setLegacyAttendanceRecords] = useState([]);
  const [attendanceStatus, setAttendanceStatus] = useState({});
  const [activityLog, setActivityLog] = useState(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('icea-activity-log') || '[]');
      return Array.isArray(stored) ? stored : [];
    } catch {
      return [];
    }
  });
  const [period, setPeriod] = useState('Este mês');
  const [notice, setNotice] = useState('');
  const [notificationsEnabled, setNotificationsEnabled] = useState(() => localStorage.getItem('icea-notifications') !== 'false');
  const [dashboard, setDashboard] = useState(() => {
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      return cached ? JSON.parse(cached) : EMPTY_DASHBOARD;
    } catch {
      return EMPTY_DASHBOARD;
    }
  });
  const [sync, setSync] = useState(() => {
    const hasCache = (() => {
      try {
        return !!localStorage.getItem(CACHE_KEY);
      } catch {
        return false;
      }
    })();
    return hasCache ? { status: 'live', savedAt: 0, error: '' } : { status: 'loading', savedAt: 0, error: '' };
  });
  const syncEmCurso = useRef(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#111b20' : '#eef3f4');
    localStorage.setItem('icea-theme', theme);
  }, [theme]);

  useEffect(() => {
    let unsubscribeProfile = () => {};
    const unsubscribeAuth = subscribeToAuthState((user) => {
      unsubscribeProfile();
      if (!user) {
        try {
          localStorage.removeItem(CACHE_KEY);
          localStorage.removeItem('icea-activity-log');
        } catch {}
        setDashboard(EMPTY_DASHBOARD);
        setActivityLog([]);
        setFotos({});
        setFotosCarregadas(false);
        setLegacyVisitorRecords([]);
        setLegacyAttendanceRecords([]);
        setAttendanceStatus({});
        setConfirmarEliminacao(null);
        setModal('');
        setSync({ status: 'loading', savedAt: 0, error: '' });
        setAuthSession({ loading: false, user: null, profile: null, error: '' });
        return;
      }

      setAuthSession({ loading: true, user, profile: null, error: '' });
      unsubscribeProfile = subscribeToUserProfile(user, (profile) => {
        setAuthSession({ loading: false, user, profile, error: '' });
      }, (error) => {
        setAuthSession({ loading: false, user, profile: { status: 'user' }, error: error.message });
      });
    });

    return () => {
      unsubscribeAuth();
      unsubscribeProfile();
    };
  }, []);

  useEffect(() => {
    if (!authSession.user || authSession.loading) return undefined;

    const onReadError = () => setNotice('Não foi possível atualizar as listas. Tente novamente daqui a pouco.');
    const unsubscribeVisitors = subscribeToVisitorRecords(setLegacyVisitorRecords, onReadError);
    const unsubscribeAttendance = subscribeToAttendanceRecords(setLegacyAttendanceRecords, onReadError);
    return () => {
      unsubscribeVisitors();
      unsubscribeAttendance();
    };
  }, [authSession.user, authSession.loading]);

  const isAdmin = authSession.profile?.status === 'admin';

  const syncDashboard = useCallback(({ silent = false, force = false } = {}) => {
    if (syncEmCurso.current) {
      if (!force) return syncEmCurso.current;
      return syncEmCurso.current.then(() => syncDashboard({ silent, force: false }));
    }
    if (!silent) setSync((current) => ({ ...current, status: 'loading', error: '' }));

    const execucao = (async () => {
      try {
        const data = await api.getDashboard();
        setDashboard(data);
        try {
          localStorage.setItem(CACHE_KEY, JSON.stringify(data));
        } catch {}
        setSync({ status: 'live', savedAt: Date.now(), error: '' });
      } catch (error) {
        const hasExisting = (() => {
          try {
            const cached = localStorage.getItem(CACHE_KEY);
            return Boolean(cached && cached.length > 0);
          } catch {
            return false;
          }
        })();
        if (!hasExisting) setDashboard(EMPTY_DASHBOARD);
        setSync({ status: 'error', savedAt: 0, error: error.message });
      } finally {
        syncEmCurso.current = null;
      }
    })();

    syncEmCurso.current = execucao;
    return execucao;
  }, []);

  useEffect(() => {
    if (authSession.user && !authSession.loading) syncDashboard();
  }, [authSession.user, authSession.loading, syncDashboard]);

  useEffect(() => {
    if (!authSession.user || authSession.loading) return undefined;

    const atualizarSeVisivel = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) syncDashboard({ silent: true });
    };
    const intervalo = setInterval(atualizarSeVisivel, SYNC_INTERVAL_MS);
    document.addEventListener('visibilitychange', atualizarSeVisivel);
    window.addEventListener('focus', atualizarSeVisivel);
    window.addEventListener('online', atualizarSeVisivel);

    return () => {
      clearInterval(intervalo);
      document.removeEventListener('visibilitychange', atualizarSeVisivel);
      window.removeEventListener('focus', atualizarSeVisivel);
      window.removeEventListener('online', atualizarSeVisivel);
    };
  }, [authSession.user, authSession.loading, syncDashboard]);

  const classes = dashboard.classes ?? [];
  const members = useMemo(() => dashboard.members ?? [], [dashboard.members]);
  const sessions = dashboard.sessions ?? [];
  const stats = dashboard.stats ?? {};
  const apiVisitors = useMemo(() => dashboard.visitors ?? [], [dashboard.visitors]);
  const visitors = useMemo(
    () => mergeVisitors(apiVisitors, legacyVisitorRecords),
    [apiVisitors, legacyVisitorRecords],
  );
  const attendanceRecords = useMemo(
    () => mergeAttendance(dashboard.attendanceRecords ?? [], legacyAttendanceRecords),
    [dashboard.attendanceRecords, legacyAttendanceRecords],
  );
  const visibleMembers = members.map((person) => ({ ...person, status: attendanceStatus[person.id] || person.status }));
  const todayKey = hojeIso();
  const notifications = useMemo(() => {
    const today = new Date(`${todayKey}T00:00:00`);
    const birthdays = members
      .map((member) => birthdayReminder(member, today))
      .filter(Boolean)
      .sort((a, b) => a.daysUntil - b.daysUntil);

    const now = Date.now();
    const activity = activityLog
      .filter((entry) => entry && entry.at && now - entry.at <= 30 * 86400000)
      .sort((a, b) => b.at - a.at)
      .slice(0, 10);

    const visitorWhen = (visitor) => {
      const created = visitor.createdAt ?? visitor.created_at;
      return (typeof created === 'string' || typeof created === 'number') ? created : visitor.date;
    };
    const recentVisitors = visitors
      .map((visitor) => ({ ...visitor, daysUntil: daysFromToday(visitorWhen(visitor), today) }))
      .sort((a, b) => dateKey(visitorWhen(b)).localeCompare(dateKey(visitorWhen(a))))
      .slice(0, 5);

    const upcomingSessions = sessions
      .map((session) => {
        const value = session.date || session.data || session.start;
        return { ...session, sessionValue: value, daysUntil: daysFromToday(value, today) };
      })
      .filter((session) => session.daysUntil != null && session.daysUntil >= 0 && session.daysUntil <= 30)
      .sort((a, b) => a.daysUntil - b.daysUntil)
      .slice(0, 5);

    const pendingAttendance = sessions
      .map((session) => {
        const value = session.date || session.data || session.start;
        const daysUntil = daysFromToday(value, today);
        const matriculados = Number(session.matriculados ?? session.students ?? 0);
        const presencas = Number(session.presencas ?? session.present ?? 0);
        if (daysUntil == null || daysUntil >= 0 || daysUntil < -30) return null;
        if (!(matriculados > 0) || presencas > 0) return null;
        return { ...session, sessionValue: value, daysUntil, matriculados, presencas };
      })
      .filter(Boolean)
      .sort((a, b) => b.daysUntil - a.daysUntil)
      .slice(0, 5);

    const missingBirthdays = members.filter((member) => !['birth_date', 'birthDate', 'data_nascimento', 'dataNascimento'].some((field) => member[field]));

    return { birthdays, activity, recentVisitors, upcomingSessions, pendingAttendance, missingBirthdays };
  }, [members, visitors, sessions, activityLog, todayKey]);

  const notificationCount = notifications.birthdays.filter((item) => item.daysUntil <= 7).length
    + notifications.activity.length
    + notifications.upcomingSessions.filter((item) => item.daysUntil <= 7).length
    + notifications.pendingAttendance.length;
  const isBootLoading = sync.status === 'loading' && !classes.length && !members.length && !sessions.length && !visitors.length;
  const hasNoData = !classes.length && !members.length && !sessions.length && !visitors.length;

  useEffect(() => {
    const dataDe = (record) => String(
      record.sessionDate
      || record.session_date
      || record.date
      || record.createdAt?.toDate?.()?.toISOString?.()
      || '',
    );
    const recentesPrimeiro = [...attendanceRecords].sort((a, b) => dataDe(b).localeCompare(dataDe(a)));
    const nextStatuses = {};
    for (const record of recentesPrimeiro) {
      for (const entry of record.attendance || []) {
        if (!(entry.memberId in nextStatuses) && entry.status) nextStatuses[entry.memberId] = entry.status;
      }
    }
    setAttendanceStatus(nextStatuses);
  }, [attendanceRecords]);

  useEffect(() => {
    if (!members.length && !apiVisitors.length) return;
    const readKnown = (key) => {
      try {
        const value = JSON.parse(localStorage.getItem(key) || 'null');
        return Array.isArray(value) ? value : null;
      } catch {
        return null;
      }
    };
    const knownMembers = readKnown('icea-known-members');
    const knownVisitors = readKnown('icea-known-visitors');
    const now = Date.now();
    const entries = [];
    if (knownMembers) {
      const known = new Set(knownMembers.map(String));
      members.forEach((member) => {
        if (member?.id != null && !known.has(String(member.id))) {
          entries.push({ key: `aluno-${member.id}`, kind: 'aluno', name: member.name || member.nome || 'Aluno', at: now });
        }
      });
    }
    if (knownVisitors) {
      const known = new Set(knownVisitors.map(String));
      apiVisitors.forEach((visitor) => {
        if (visitor?.id != null && !known.has(String(visitor.id))) {
          entries.push({ key: `visitante-${visitor.id}`, kind: 'visitante', name: visitor.name || 'Visitante', at: now });
        }
      });
    }
    try {
      if (members.length) localStorage.setItem('icea-known-members', JSON.stringify(members.map((member) => String(member.id))));
      if (apiVisitors.length) localStorage.setItem('icea-known-visitors', JSON.stringify(apiVisitors.map((visitor) => String(visitor.id))));
    } catch {}
    if (!entries.length) return;
    setActivityLog((previous) => {
      const merged = new Map(previous.map((entry) => [entry.key, entry]));
      entries.forEach((entry) => merged.set(entry.key, entry));
      const limite = now - 30 * 86400000;
      const next = [...merged.values()].filter((entry) => entry.at >= limite).sort((a, b) => b.at - a.at).slice(0, 30);
      try {
        localStorage.setItem('icea-activity-log', JSON.stringify(next));
      } catch {}
      return next;
    });
  }, [members, apiVisitors]);

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
  const attendance = useMemo(() => attendanceSeries(sessions, period, attendanceRecords, members), [sessions, period, attendanceRecords, members]);
  const syncCopy = SYNC_COPY[sync.status];
  const toggleNotifications = () => {
    if (!isAdmin) return;
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
    if (!isAdmin) return;
    const rows = type === 'Turmas' ? classes : type === 'Pessoas' ? visibleMembers : visitors;
    const headers = type === 'Turmas' ? ['Nome', 'Professor', 'Alunos'] : type === 'Pessoas' ? ['Nome', 'Turma', 'Estado'] : ['Nome', 'Turma', 'Data'];
    const values = rows.map((item) => type === 'Turmas'
      ? [item.name, item.professor_name || '', item.alunos ?? item.students ?? '']
      : type === 'Pessoas'
        ? [item.name, getClassName(item.class_id), item.status || 'Registado']
        : [item.name, item.className || 'Visitante', item.date || '']);
    const csv = [headers, ...values].map((row) => row.map((value) => {
      let texto = String(value ?? '');
      if (/^[=+\-@]/.test(texto)) texto = `'${texto}`;
      return `"${texto.replaceAll('"', '""')}"`;
    }).join(';')).join('\n');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' }));
    link.download = `${type.toLocaleLowerCase('pt-PT')}-icea.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
    setNotice(`Ficheiro de ${type.toLocaleLowerCase('pt-PT')} exportado.`);
  }

  useEffect(() => {
    if (!authSession.user || authSession.loading || fotosCarregadas) return undefined;
    let cancelado = false;
    api.carregarFotos()
      .then((mapa) => { if (!cancelado) { setFotos(mapa || {}); setFotosCarregadas(true); } })
      .catch(() => { if (!cancelado) setFotosCarregadas(true); });
    return () => { cancelado = true; };
  }, [authSession.user, authSession.loading, fotosCarregadas]);

  async function guardarVisitante(dados) {
    if (!isAdmin) return;
    await api.criarVisitante(dados);
    setModal('');
    setNotice('Visitante registado.');
    await syncDashboard({ silent: true, force: true });
  }

  async function guardarAluno(dados) {
    if (!isAdmin) return;
    const criado = await api.criarAluno(dados);
    setModal('');
    setNotice(criado?.turma ? `Aluno registado na turma ${criado.turma}.` : 'Aluno registado.');
    await syncDashboard({ silent: true, force: true });
  }

  async function guardarPresencas(dados) {
    if (!isAdmin) return;
    await api.guardarPresencas(dados);
    setModal('');
    setNotice('Presenças registadas.');
    await syncDashboard({ silent: true, force: true });
  }

  function pedirEliminarVisitante(visitante) {
    if (!isAdmin) return;
    setConfirmarEliminacao({ tipo: 'visitante', id: visitante.id, nome: visitante.name });
  }

  function pedirEliminarAluno(aluno) {
    if (!podeEliminarAluno(isAdmin)) return;
    setConfirmarEliminacao({ tipo: 'aluno', id: aluno.id, nome: aluno.name });
  }

  async function eliminarConfirmado() {
    if (!confirmarEliminacao || !isAdmin) return;
    const alvo = confirmarEliminacao;
    try {
      if (alvo.tipo === 'visitante') await api.eliminarVisitante(alvo.id);
      else if (alvo.tipo === 'aluno') await api.eliminarAluno(alvo.id);
      setConfirmarEliminacao(null);
      setNotice(alvo.tipo === 'aluno' ? 'Aluno eliminado.' : 'Visitante eliminado.');
      await syncDashboard({ silent: true, force: true });
    } catch (error) {
      setConfirmarEliminacao(null);
      setNotice(error.message || 'Não foi possível eliminar o registo.');
    }
  }

  function escolherFoto(memberId) {
    if (!isAdmin) return;
    setAlvoFoto(memberId);
    const input = document.getElementById('input-foto');
    if (input) {
      input.value = '';
      input.click();
    }
  }

  async function aoEscolherFoto(event) {
    const ficheiro = event.target.files?.[0];
    const membro = alvoFoto;
    setAlvoFoto(null);
    if (!ficheiro || !membro || !isAdmin) return;
    try {
      setNotice('A preparar a foto...');
      const foto = await reduzirFoto(ficheiro);
      await api.guardarFoto(membro, foto);
      setFotos((current) => ({ ...current, [membro]: foto }));
      setNotice('Foto guardada.');
    } catch (error) {
      setNotice(error.message || 'Não foi possível guardar a foto.');
    }
  }

  if (authSession.loading) return <main className="auth-shell"><div className="auth-loading" role="status">A verificar sessão...</div></main>;
  if (!authSession.user) return <AuthScreen />;

  return (
    <div className="app-shell" data-role={isAdmin ? 'admin' : 'user'}>
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
            <div><strong>{syncCopy.title}</strong><small>{sync.status === 'error' && sync.error ? sync.error : syncCopy.hint}</small></div>
            <span className={`status-dot ${syncCopy.dot}`} />
          </div>
          {sync.status !== 'live' && <button className="nav-item sync-retry" onClick={() => syncDashboard()}><RefreshCw size={16} /><span>Tentar novamente</span></button>}
          <button className={`nav-item ${active === 'Definições' ? 'active' : ''}`} onClick={() => { setActive('Definições'); setMobileOpen(false); }}><Settings size={19} /><span>Definições</span></button>
          <button className="profile-mini" onClick={() => setModal('profile')}><div className="avatar avatar-profile"><UserRound size={16} /></div><div><strong>{authSession.profile?.displayName || authSession.user.displayName || authSession.user.email}</strong><small>{isAdmin ? 'Administrador' : 'Utilizador · leitura'}</small></div><MoreHorizontal size={18} /></button>
        </div>
      </aside>

      {mobileOpen && <button className="sidebar-overlay" aria-label="Fechar menu" onClick={() => setMobileOpen(false)} />}

      <main className="main-content">
        <header className="topbar">
          <button className="icon-button menu-trigger" onClick={() => setMobileOpen(true)} aria-label="Abrir menu"><Menu size={21} /></button>
          <div className="breadcrumbs"><span>ICEA</span><i>/</i><strong>{active}</strong></div>
          <div className="topbar-actions">
            {searchOpen && <div className="search-wrap search-visible"><Search size={18} /><input autoFocus value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Pesquisar..." aria-label="Pesquisar" /></div>}
            <button className="icon-button search-trigger" onClick={() => setSearchOpen((open) => !open)} aria-label={searchOpen ? 'Fechar pesquisa' : 'Pesquisar'} title={searchOpen ? 'Fechar pesquisa' : 'Pesquisar'}>{searchOpen ? <X size={19} /> : <Search size={19} />}</button>
            <button className="icon-button theme-toggle" onClick={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')} aria-label={theme === 'dark' ? 'Ativar modo claro' : 'Ativar modo escuro'} title={theme === 'dark' ? 'Modo claro' : 'Modo escuro'}>{theme === 'dark' ? <Sun size={19} /> : <Moon size={19} />}</button>
            {isAdmin && <button className="icon-button notification-button" onClick={() => setModal('notifications')} aria-label={`Notificações${notificationCount ? ` (${notificationCount})` : ''}`}><Bell size={19} />{notificationsEnabled && notificationCount > 0 && <span>{notificationCount > 9 ? '9+' : notificationCount}</span>}</button>}
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
              {isAdmin && active !== 'Presenças' && <button className="primary-button" onClick={() => setModal('attendance')} disabled={!members.length}><Plus size={17} /> Registar presença</button>}
              {isAdmin && <button className="outline-button" onClick={() => setModal('member')}><Plus size={17} /> Aluno</button>}
            </div>
          </section>

          {notice && <div className="notice-banner" role="status"><Check size={16} />{notice}<button className="notice-close" onClick={() => setNotice('')} aria-label="Fechar aviso"><X size={15} /></button></div>}

          {sync.status === 'error' && <div className="api-alert" role="alert"><CircleAlert size={17} /><span><strong>Não foi possível mostrar os dados.</strong> {sync.error} Se o problema continuar, peça ajuda ao responsável.</span><button className="icon-button" onClick={() => syncDashboard()} aria-label="Tentar novamente"><RefreshCw size={17} /></button></div>}

          {searchTerm && <section className="search-results" aria-label="Resultados da pesquisa"><div className="panel-heading"><h2>Resultados da pesquisa</h2><button className="icon-button" onClick={() => setSearchQuery('')} aria-label="Limpar pesquisa"><X size={17} /></button></div>{searchResults.length ? searchResults.slice(0, 8).map((result) => <button className="search-result" key={`${result.kind}-${result.id}`} onClick={() => { setActive(result.kind); setSearchQuery(''); }}>{result.title}<span>{result.kind}</span></button>) : <p>Não foram encontrados resultados.</p>}</section>}

          {isBootLoading ? <DashboardSkeleton /> : sync.status === 'error' && hasNoData ? null : active === 'Visão geral' ? <>
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
              {classes.length ? <div className="class-list">{classes.slice(0, 4).map((item, index) => { const professor = item.equipa?.Professor?.[0]; return <div className="class-row" key={item.id}><div className={`class-badge ${item.color || ['coral', 'sky', 'gold', 'mint'][index % 4]}`}><BookOpen size={17} /></div><div className="class-info"><strong>{item.name}</strong><small>{item.age_min != null && item.age_max != null ? `${item.age_min}–${item.age_max} anos` : 'Faixa etária não indicada'} <i /> {item.professor_name || professor?.nome || 'Equipa por consultar'}</small></div><div className="class-stat"><strong>{item.attendance != null ? `${item.attendance}%` : item.alunos ?? item.students ?? 0}</strong><small>{item.attendance != null ? 'presença' : 'alunos'}</small></div><ChevronDown size={16} className="row-chevron" /></div>; })}</div> : <EmptyState icon={BookOpen} title="Ainda não há turmas para mostrar" hint="As turmas aparecerão aqui quando estiverem disponíveis." />}
            </div>
          </section>

          <section className="bottom-grid">
            <div className="panel people-panel"><div className="panel-heading"><div><span className="section-kicker">Últimos registos</span><h2>Pessoas recentes</h2></div>{isAdmin && <button className="icon-button" onClick={() => exportCsv('Pessoas')} disabled={!visibleMembers.length} aria-label="Exportar pessoas"><Download size={17} /></button>}</div>{visibleMembers.length ? <div className="people-table"><div className="table-head"><span>Pessoa</span><span>Turma</span><span>Estado</span></div>{visibleMembers.slice(0, 4).map((person) => <div className="person-row" key={person.id}><div className="person-name">{fotos[person.id] ? <img className="avatar avatar-photo" src={fotos[person.id]} alt="" /> : <div className="avatar">{person.initials || initialsOf(person.name)}</div>}<strong>{person.name}</strong></div><span data-label="Turma">{getClassName(person.class_id)}</span><span className="status-cell" data-label="Estado"><span className={`presence ${person.status === 'Ausente' ? 'absent' : person.status === 'Presente' ? 'present' : 'unknown'}`}><i />{person.status || 'Sem estado'}</span>{podeEliminarAluno(isAdmin) && <button className="icon-button danger-icon" onClick={() => pedirEliminarAluno(person)} title="Eliminar aluno" aria-label={`Eliminar aluno ${person.name}`}><Trash2 size={14} /></button>}</span></div>)}</div> : <EmptyState icon={UsersRound} title="Ainda não há pessoas para mostrar" hint="Se esperava ver nomes, atualize os dados. Se continuar, peça ajuda ao responsável." />}</div>
            <div className="panel visitors-panel"><div className="panel-heading"><div><span className="section-kicker">Acolhimento</span><h2>Visitantes recentes</h2></div><button className="text-button" onClick={() => setActive('Pessoas')}>Ver todos <span>↗</span></button></div>{visitors.length ? <div className="visitor-list">{visitors.slice(0, 3).map((visitor) => <div className="visitor-row" key={visitor.id}><div className="avatar visitor-avatar">{visitor.initials || initialsOf(visitor.name)}</div><div><strong>{visitor.name}</strong><small>{visitor.className || 'Visitante'}</small></div><time>{visitor.date || 'Data indisponível'}</time>{isAdmin && <button className="icon-button danger-icon" onClick={() => pedirEliminarVisitante(visitor)} title="Eliminar visitante" aria-label={`Eliminar visitante ${visitor.name}`}><Trash2 size={14} /></button>}</div>)}</div> : <EmptyState icon={Sparkles} title="Sem visitantes registados" hint="Os visitantes aparecem aqui depois de uma sessão." />}{isAdmin && <button className="outline-button" onClick={() => setModal('visitor')}><Plus size={16} /> Adicionar visitante</button>}</div>
          </section>
          </> : hasNoData ? <EmptyState icon={Inbox} title="Ainda não há dados para mostrar" hint="Atualize os dados. Se continuar sem informação, peça ajuda ao responsável." /> : <WorkspacePage active={active} classes={classes} members={visibleMembers} visitors={visitors} sessions={sessions} attendanceRecords={attendanceRecords} getClassName={getClassName} onExport={exportCsv} sync={sync} onSync={() => syncDashboard()} notificationsEnabled={notificationsEnabled} onToggleNotifications={toggleNotifications} isAdmin={isAdmin} fotos={fotos} onPhoto={escolherFoto} onAttendance={() => setModal('attendance')} onVisitor={() => setModal('visitor')} onMember={() => setModal('member')} onDeleteVisitor={pedirEliminarVisitante} onDeleteMember={pedirEliminarAluno} />}
        </div>
      </main>
      {modal && <ActionDialog type={modal} classes={classes} members={visibleMembers} notifications={notifications} onClose={() => setModal('')} onSaveAttendance={guardarPresencas} onSaveVisitor={guardarVisitante} onSaveMember={guardarAluno} notificationsEnabled={notificationsEnabled} onToggleNotifications={toggleNotifications} user={authSession.user} profile={authSession.profile} onSignOut={signOutUser} />}

      {confirmarEliminacao && <ConfirmDialog
        title={confirmarEliminacao.tipo === 'aluno' ? 'Eliminar aluno' : 'Eliminar visitante'}
        message={`Tem a certeza de que quer eliminar ${confirmarEliminacao.tipo === 'aluno' ? 'o aluno' : 'o visitante'} "${confirmarEliminacao.nome}"? Esta ação não pode ser revertida.`}
        confirmLabel="Eliminar"
        onConfirm={eliminarConfirmado}
        onCancel={() => setConfirmarEliminacao(null)}
      />}

      <input id="input-foto" type="file" accept="image/*" className="input-foto-oculto" onChange={aoEscolherFoto} aria-label="Escolher foto do aluno" />

      <PwaBar online={online} canInstall={canInstall} onInstall={install} onDismissInstall={dismissInstall} updateReady={updateReady} onApplyUpdate={applyUpdate} />
    </div>
  );
}

function PwaBar({ online, canInstall, onInstall, onDismissInstall, updateReady, onApplyUpdate }) {
  if (online && !canInstall && !updateReady) return null;

  return <div className="pwa-stack">
    {!online && <div className="pwa-card pwa-offline" role="status"><WifiOff size={17} /><span>Sem ligação à internet. Volte a ligar-se para carregar os dados.</span></div>}
    {updateReady && <div className="pwa-card pwa-update" role="status"><RefreshCw size={17} /><span>Está disponível uma nova versão da aplicação.</span><button className="pwa-action" onClick={onApplyUpdate}>Actualizar agora</button></div>}
    {canInstall && <div className="pwa-card pwa-install" role="status"><img className="pwa-logo" src="/faviconICEA/web-app-manifest-192x192.png" alt="" width="38" height="38" /><div className="pwa-copy"><strong>Instalar a aplicação</strong><span>Abre directamente no telemóvel, sem barra de browser.</span></div><button className="pwa-action" onClick={onInstall}>Instalar</button><button className="icon-button" onClick={onDismissInstall} aria-label="Fechar aviso de instalação"><X size={16} /></button></div>}
  </div>;
}

function EmptyState({ icon: Icon = Inbox, title, hint }) {
  return <div className="empty-state"><Icon size={24} /><strong>{title}</strong>{hint && <span>{hint}</span>}</div>;
}

function ConfirmDialog({ title, message, confirmLabel = 'Confirmar', onConfirm, onCancel }) {
  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}><section className="action-dialog confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title"><div className="dialog-heading"><h2 id="confirm-title">{title}</h2><button className="icon-button" onClick={onCancel} aria-label="Fechar"><X size={18} /></button></div><p className="confirm-message">{message}</p><div className="confirm-actions"><button className="outline-button" onClick={onCancel}>Cancelar</button><button className="danger-button" onClick={onConfirm}><Trash2 size={16} /> {confirmLabel}</button></div></section></div>;
}

function NotificationGroup({ icon: Icon, tone = '', title, hint, count = 0, children }) {
  return <section className={`notification-group ${tone}`}>
    <header>
      <span className="notification-group-icon"><Icon size={16} /></span>
      <div><h3>{title}</h3>{hint && <small>{hint}</small>}</div>
      {count > 0 && <span className="notification-count">{count}</span>}
    </header>
    <div className="notification-items">{children}</div>
  </section>;
}

function DashboardSkeleton() {
  return <div className="skeleton-wrap" aria-busy="true" aria-label="A carregar dados">
    <section className="stats-grid">{Array.from({ length: 4 }, (_, index) => <article className="stat-card" key={index}><div className="skeleton skeleton-icon" /><div className="skeleton-lines"><span className="skeleton" style={{ width: '58%' }} /><span className="skeleton" style={{ width: '38%', height: 24 }} /><span className="skeleton" style={{ width: '44%' }} /></div></article>)}</section>
    <section className="content-grid"><div className="panel"><span className="skeleton" style={{ width: 180, height: 16 }} /><div className="skeleton skeleton-chart" /></div><div className="panel"><span className="skeleton" style={{ width: 140, height: 16 }} />{Array.from({ length: 4 }, (_, index) => <div className="skeleton" style={{ height: 44, marginTop: 14 }} key={index} />)}</div></section>
  </div>;
}

function WorkspacePage({ active, classes, members, visitors, sessions, attendanceRecords = [], getClassName, onExport, sync, onSync, notificationsEnabled, onToggleNotifications, isAdmin, fotos = {}, onPhoto, onAttendance, onVisitor, onMember, onDeleteVisitor, onDeleteMember }) {
  function avatarPessoa(person) {
    const foto = fotos[person.id];
    if (foto) {
      return isAdmin && onPhoto
        ? <button type="button" className="avatar avatar-button" onClick={() => onPhoto(person.id)} title="Alterar foto" aria-label={`Alterar foto de ${person.name}`}><img className="avatar-photo" src={foto} alt="" /></button>
        : <img className="avatar avatar-photo" src={foto} alt="" />;
    }
    if (isAdmin && onPhoto) {
      return <button type="button" className="avatar avatar-button" onClick={() => onPhoto(person.id)} title="Adicionar foto" aria-label={`Adicionar foto a ${person.name}`}><Camera size={14} /></button>;
    }
    return <span className="avatar">{person.initials || initialsOf(person.name)}</span>;
  }
  if (active === 'Turmas') return <section className="workspace-view"><div className="workspace-heading"><div><span className="section-kicker">Organização</span><h1>Turmas</h1><p>{classes.length ? plural(classes.length, 'turma disponível', 'turmas disponíveis') : 'Sem dados recebidos'}</p></div><button className="outline-button export-button" onClick={() => onExport('Turmas')} disabled={!classes.length}><Download size={16} /> Exportar CSV</button></div>{classes.length ? <div className="workspace-list">{classes.map((item, index) => <article className="workspace-row" key={item.id}><div className={`class-badge ${item.color || ['coral', 'sky', 'gold', 'mint'][index % 4]}`}><BookOpen size={17} /></div><div className="workspace-row-copy"><strong>{item.name}</strong><small>{item.age_min != null && item.age_max != null ? `${item.age_min}–${item.age_max} anos` : 'Faixa etária não indicada'} · {item.professor_name || item.equipa?.Professor?.[0]?.nome || 'Equipa por consultar'}</small></div><span>{item.alunos ?? item.students ?? 0} alunos</span></article>)}</div> : <EmptyState icon={BookOpen} title="Ainda não há turmas para mostrar" hint="As turmas aparecerão aqui quando estiverem disponíveis." />}</section>;

  if (active === 'Pessoas') return <section className="workspace-view"><div className="workspace-heading"><div><span className="section-kicker">Comunidade</span><h1>Pessoas</h1><p>{members.length || visitors.length ? `${plural(members.length, 'pessoa registada', 'pessoas registadas')} e ${plural(visitors.length, 'visitante', 'visitantes')}` : 'Ainda não há pessoas para mostrar'}</p></div><div className="workspace-actions"><button className="outline-button export-button" onClick={() => onExport('Pessoas')} disabled={!members.length}><Download size={16} /> Exportar</button>{isAdmin && <button className="outline-button" onClick={onVisitor}><Plus size={16} /> Visitante</button>}{isAdmin && <button className="primary-button" onClick={onMember}><Plus size={16} /> Aluno</button>}</div></div>{members.length ? <div className="panel workspace-table"><div className="workspace-table-head"><span>Nome</span><span>Turma</span><span>Estado</span></div>{members.map((person) => <div className="workspace-table-row" key={person.id}><strong>{avatarPessoa(person)}{person.name}</strong><span data-label="Turma">{getClassName(person.class_id)}</span><span className="status-cell" data-label="Estado"><span className={`presence ${person.status === 'Ausente' ? 'absent' : person.status === 'Presente' ? 'present' : 'unknown'}`}><i />{person.status || 'Sem estado'}</span>{podeEliminarAluno(isAdmin) && onDeleteMember && <button className="icon-button danger-icon" onClick={() => onDeleteMember(person)} title="Eliminar aluno" aria-label={`Eliminar aluno ${person.name}`}><Trash2 size={14} /></button>}</span></div>)}</div> : <EmptyState icon={UsersRound} title="Ainda não há pessoas para mostrar" hint="Se esperava ver nomes, atualize os dados. Se continuar, peça ajuda ao responsável." />}<h2 className="workspace-subheading">Visitantes</h2>{visitors.length ? <div className="panel workspace-table">{visitors.map((visitor) => <div className="workspace-table-row visitor-table-row" key={visitor.id}><strong>{visitor.name}</strong><span data-label="Turma">{visitor.className || 'Visitante'}</span><span className="visitor-date-cell" data-label="Data">{visitor.date || 'Data indisponível'}{isAdmin && onDeleteVisitor && <button className="icon-button danger-icon" onClick={() => onDeleteVisitor(visitor)} title="Eliminar visitante" aria-label={`Eliminar visitante ${visitor.name}`}><Trash2 size={14} /></button>}</span></div>)}</div> : <EmptyState icon={Sparkles} title="Ainda não há visitantes para mostrar" hint="Os visitantes aparecerão aqui quando forem registados." />}</section>;

  if (active === 'Presenças') {
    const records = attendanceRecords.slice().sort((a, b) => {
      const da = a.sessionDate || a.createdAt?.toDate?.()?.toISOString?.() || '';
      const db = b.sessionDate || b.createdAt?.toDate?.()?.toISOString?.() || '';
      return db.localeCompare(da);
    });
    return <section className="workspace-view"><div className="workspace-heading"><div><span className="section-kicker">Acompanhamento</span><h1>Presenças</h1><p>Registos de presença por data de sessão</p></div>{isAdmin && <button className="primary-button" onClick={onAttendance} disabled={!members.length}><Plus size={16} /> Registar presença</button>}</div>
      {records.length ? records.map((rec) => {
        const sessDate = rec.sessionDate || (rec.createdAt?.toDate?.() ? rec.createdAt.toDate().toISOString().slice(0,10) : '');
        const turmas = classes.filter((c) => String(c.id) === String(rec.classId));
        const turmaNome = turmas[0]?.name || rec.className || rec.classId;
        const items = (rec.attendance || []).map((e) => {
          const m = members.find((mm) => String(mm.id) === String(e.memberId));
          return { ...e, name: m?.name || e.memberId };
        });
        return <section className="panel attendance-class" key={rec.id}>
          <div className="panel-heading"><div><span className="section-kicker">Sessão</span><h2>{turmaNome} · {formatDatePt(sessDate) || 'Data não indicada'}</h2></div><span className="attendance-count">{items.filter((i) => i.status === 'Presente').length}/{items.length} presentes</span></div>
          {items.map((i) => <div className="attendance-person" key={i.memberId}>{fotos[i.memberId] ? <img className="avatar avatar-photo" src={fotos[i.memberId]} alt="" /> : <div className="avatar">{initialsOf(i.name)}</div>}<strong>{i.name}</strong><span className={`presence ${i.status === 'Ausente' ? 'absent' : 'present'}`}><i />{i.status}</span></div>)}
        </section>;
      }) : <EmptyState icon={BookOpen} title="Sem registos de presença" hint="Registe presenças para cada domingo/turma. Os registos aparecem aqui agrupados por data." />}
    </section>;
  }

  if (active === 'Calendário') return <section className="workspace-view"><div className="workspace-heading"><div><span className="section-kicker">Agenda</span><h1>Calendário</h1><p>{sessions.length ? plural(sessions.length, 'sessão recebida', 'sessões recebidas') : 'Sem dados recebidos'}</p></div></div>{sessions.length ? <div className="workspace-list">{sessions.map((session, index) => <article className="workspace-row" key={session.id || index}><div className="class-badge sky"><CalendarDays size={17} /></div><div className="workspace-row-copy"><strong>{session.name || session.turma || session.class_name || `Sessão ${index + 1}`}</strong><small>{session.date || session.data || session.start || 'Data não indicada'}</small></div><span>{session.time || session.hora || ''}</span></article>)}</div> : <EmptyState icon={CalendarDays} title="Ainda não há sessões para mostrar" hint="As próximas sessões aparecerão aqui quando forem registadas." />}</section>;

  return <section className="workspace-view"><div className="workspace-heading"><div><span className="section-kicker">Aplicação</span><h1>Definições</h1><p>Preferências e estado dos dados</p></div></div><div className="panel settings-list"><div className="setting-row"><span><strong>Dados da comunidade</strong><small>A informação é atualizada quando entra no painel.</small></span><span className={`setting-status ${sync.status === 'live' ? '' : 'setting-status-warn'}`}>{sync.status === 'live' ? 'Ligação ativa' : sync.status === 'loading' ? 'A carregar' : 'Indisponível'}</span></div><div className="setting-row"><span><strong>Última atualização</strong><small>{sync.savedAt ? relativeTime(sync.savedAt) : 'Ainda não foi atualizada'}</small></span><button className="outline-button export-button" onClick={onSync} disabled={sync.status === 'loading'}><RefreshCw size={16} /> Atualizar</button></div><div className="setting-row"><span><strong>Exportação</strong><small>Descarregar listas de turmas e pessoas</small></span><button className="outline-button export-button" onClick={() => onExport('Turmas')} disabled={!classes.length}><Download size={16} /> Exportar turmas</button></div><div className="setting-row"><span><strong>Notificações</strong><small>Mostrar o indicador de notificações na barra superior</small></span><input type="checkbox" checked={notificationsEnabled} onChange={onToggleNotifications} /></div><div className="setting-row"><span><strong>Conta</strong><small>A autenticação está ativa.</small></span><span className="setting-status">{sync.status === 'live' ? 'Acesso confirmado' : 'Sessão iniciada'}</span></div></div></section>;
}

function ActionDialog({ type, classes = [], members = [], notifications = {}, onClose, onSaveAttendance, onSaveVisitor, onSaveMember, notificationsEnabled, onToggleNotifications, user, profile, onSignOut }) {
  const [selectedClass, setSelectedClass] = useState(classes[0]?.id ?? '');
  const [selectedMembers, setSelectedMembers] = useState([]);
  const [sessionDate, setSessionDate] = useState(hojeIso());
  const [visitorName, setVisitorName] = useState('');
  const [visitorDate, setVisitorDate] = useState(hojeIso());
  const [memberName, setMemberName] = useState('');
  const [memberBirth, setMemberBirth] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');
  const classMembers = members.filter((person) => String(person.class_id) === String(selectedClass));
  const classLabel = (value) => classes.find((item) => String(item.id) === String(value))?.name || value || 'Turma';
  const notificationLists = {
    birthdays: notifications.birthdays ?? [],
    activity: notifications.activity ?? [],
    recentVisitors: notifications.recentVisitors ?? [],
    upcomingSessions: notifications.upcomingSessions ?? [],
    pendingAttendance: notifications.pendingAttendance ?? [],
    missingBirthdays: notifications.missingBirthdays ?? [],
  };

  useEffect(() => { setSelectedMembers([]); }, [selectedClass]);

  const titleMap = {
    attendance: 'Registar presenças',
    visitor: 'Adicionar visitante',
    member: 'Novo aluno',
    notifications: 'Notificações',
    profile: 'Perfil',
  };

  async function enviar(acao) {
    setEnviando(true);
    setErro('');
    try {
      await acao();
    } catch (error) {
      setErro(error.message || 'Não foi possível guardar. Tente novamente.');
    } finally {
      setEnviando(false);
    }
  }

  function submeterPresencas(event) {
    event.preventDefault();
    enviar(() => onSaveAttendance({
      classId: selectedClass,
      date: sessionDate,
      attendance: classMembers.map((person) => ({
        memberId: person.id,
        status: selectedMembers.includes(person.id) ? 'Presente' : 'Ausente',
      })),
    }));
  }

  function submeterVisitante(event) {
    event.preventDefault();
    enviar(() => onSaveVisitor({ name: visitorName.trim(), classId: selectedClass, date: visitorDate }));
  }

  function submeterAluno(event) {
    event.preventDefault();
    enviar(() => onSaveMember({ name: memberName.trim(), birth_date: memberBirth }));
  }

  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !enviando) onClose(); }}><section className="action-dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><div className="dialog-heading"><h2 id="dialog-title">{titleMap[type] ?? 'Diálogo'}</h2><button className="icon-button" onClick={onClose} aria-label="Fechar" disabled={enviando}><X size={18} /></button></div>

    {type === 'attendance' && <form onSubmit={submeterPresencas}>
      <label className="form-field">Turma<select value={selectedClass} onChange={(event) => setSelectedClass(event.target.value)}>{classes.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
      <label className="form-field">Data da sessão<input type="date" value={sessionDate} onChange={(event) => setSessionDate(event.target.value)} required /></label>
      {classMembers.length ? <div className="attendance-checklist">{classMembers.map((person) => <label className="check-row" key={person.id}><input type="checkbox" checked={selectedMembers.includes(person.id)} onChange={(event) => setSelectedMembers((current) => event.target.checked ? [...current, person.id] : current.filter((id) => id !== person.id))} /><span>{person.name}</span></label>)}</div> : <p className="dialog-note">Esta turma ainda não tem pessoas registadas.</p>}
      <p className="dialog-note">Assinale quem está presente. Os restantes ficam como ausentes nesta data.</p>
      {erro && <p className="dialog-erro" role="alert">{erro}</p>}
      <button className="primary-button dialog-submit" type="submit" disabled={enviando || !classMembers.length}>{enviando ? 'A guardar...' : <><Check size={16} /> Guardar presenças</>}</button>
    </form>}

    {type === 'visitor' && <form onSubmit={submeterVisitante}>
      <label className="form-field">Nome completo<input value={visitorName} onChange={(event) => setVisitorName(event.target.value)} required minLength={2} autoFocus placeholder="Nome do visitante" /></label>
      <label className="form-field">Turma de acolhimento<select value={selectedClass} onChange={(event) => setSelectedClass(event.target.value)}>{classes.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
      <label className="form-field">Data da sessão<input type="date" value={visitorDate} onChange={(event) => setVisitorDate(event.target.value)} required /></label>
      <p className="dialog-note">O visitante fica associado à turma escolhida nesta data.</p>
      {erro && <p className="dialog-erro" role="alert">{erro}</p>}
      <button className="primary-button dialog-submit" type="submit" disabled={enviando || !classes.length}>{enviando ? 'A guardar...' : <><Plus size={16} /> Guardar visitante</>}</button>
    </form>}

    {type === 'member' && <form onSubmit={submeterAluno}>
      <label className="form-field">Nome completo<input value={memberName} onChange={(event) => setMemberName(event.target.value)} required minLength={2} autoFocus placeholder="Nome do aluno" /></label>
      <label className="form-field">Data de nascimento<input type="date" value={memberBirth} onChange={(event) => setMemberBirth(event.target.value)} required /></label>
      <p className="dialog-note">A turma é calculada automaticamente pela idade. A foto pode ser acrescentada na lista de Pessoas.</p>
      {erro && <p className="dialog-erro" role="alert">{erro}</p>}
      <button className="primary-button dialog-submit" type="submit" disabled={enviando}>{enviando ? 'A guardar...' : <><Plus size={16} /> Guardar aluno</>}</button>
    </form>}

    {type === 'notifications' && <div className="notifications-panel">
      <p className="notifications-summary">Alertas da comunidade: aniversários, novos registos, eventos, visitantes e presenças por registar.</p>

      <NotificationGroup icon={Cake} tone="cake" title="Aniversários" hint="Hoje, amanhã e próximos 30 dias" count={notificationLists.birthdays.length}>
        {notificationLists.birthdays.length ? notificationLists.birthdays.map((item) => (
          <div className="notification-item" key={`${item.id}-${item.daysUntil}`}>
            <div className="notification-avatar">{initialsOf(item.name)}</div>
            <div className="notification-copy">
              <strong>{item.name}</strong>
              <span>{item.turningAge ? `${item.turningAge} anos · ` : ''}{item.date} · {item.daysUntil === 0 ? 'é hoje' : item.daysUntil === 1 ? 'é amanhã' : `daqui a ${item.daysUntil} dias`}</span>
            </div>
            <span className={`notification-tag ${item.daysUntil <= 1 ? 'urgent' : ''}`}>{relativeDayLabel(item.daysUntil)}</span>
          </div>
        )) : <p className="notification-empty">Sem aniversários nos próximos 30 dias.</p>}
      </NotificationGroup>

      <NotificationGroup icon={UserPlus} title="Novas atualizações" hint="Alunos e visitantes desde a última visita" count={notificationLists.activity.length}>
        {notificationLists.activity.length ? notificationLists.activity.map((item) => (
          <div className="notification-item" key={item.key}>
            <span className={`notification-dot ${item.kind}`} />
            <div className="notification-copy"><strong>{item.kind === 'aluno' ? 'Novo aluno' : 'Novo visitante'}: {item.name}</strong><span>{relativeTime(item.at)}</span></div>
          </div>
        )) : <p className="notification-empty">Sem atualizações desde a última visita.</p>}
      </NotificationGroup>

      <NotificationGroup icon={CalendarDays} tone="events" title="Eventos e sessões" hint="Próximos 30 dias" count={notificationLists.upcomingSessions.length}>
        {notificationLists.upcomingSessions.length ? notificationLists.upcomingSessions.map((session, index) => (
          <div className="notification-item" key={session.id || `${session.class_id}-${session.sessionValue}-${index}`}>
            <span className="notification-date">{formatDateShort(session.sessionValue)}</span>
            <div className="notification-copy"><strong>{classLabel(session.class_id ?? session.classId ?? session.turma)}</strong><span>{relativeDayLabel(session.daysUntil)}{session.time || session.hora ? ` · ${session.time || session.hora}` : ''}</span></div>
            <span className={`notification-tag ${session.daysUntil <= 1 ? 'urgent' : ''}`}>{relativeDayLabel(session.daysUntil)}</span>
          </div>
        )) : <p className="notification-empty">Sem sessões nos próximos 30 dias.</p>}
      </NotificationGroup>

      <NotificationGroup icon={Sparkles} title="Convidados recentes" hint="Últimos visitantes" count={notificationLists.recentVisitors.length}>
        {notificationLists.recentVisitors.length ? notificationLists.recentVisitors.map((visitor) => (
          <div className="notification-item" key={visitor.id || `${visitor.name}-${visitor.date}`}>
            <div className="notification-avatar">{initialsOf(visitor.name)}</div>
            <div className="notification-copy"><strong>{visitor.name}</strong><span>{visitor.className || 'Visitante'} · {formatDateShort(visitor.date)}</span></div>
          </div>
        )) : <p className="notification-empty">Sem visitantes registados.</p>}
      </NotificationGroup>

      <NotificationGroup icon={ClipboardCheck} tone="attendance" title="Presenças pendentes" hint="Sessões dos últimos 30 dias sem presenças" count={notificationLists.pendingAttendance.length}>
        {notificationLists.pendingAttendance.length ? notificationLists.pendingAttendance.map((session, index) => (
          <div className="notification-item" key={session.id || `${session.class_id}-${session.sessionValue}-${index}`}>
            <span className="notification-date">{formatDateShort(session.sessionValue)}</span>
            <div className="notification-copy"><strong>{classLabel(session.class_id ?? session.classId ?? session.turma)}</strong><span>{session.matriculados} inscritos · 0 presenças</span></div>
            <span className="notification-tag urgent">Registar</span>
          </div>
        )) : <p className="notification-empty">Sem presenças em falta.</p>}
      </NotificationGroup>

      {notificationLists.missingBirthdays.length > 0 && <NotificationGroup icon={UserRound} title="Dados por completar" hint="Alunos sem data de nascimento" count={notificationLists.missingBirthdays.length}>
        {notificationLists.missingBirthdays.slice(0, 5).map((member) => (
          <div className="notification-item" key={member.id}>
            <div className="notification-avatar">{initialsOf(member.name)}</div>
            <div className="notification-copy"><strong>{member.name}</strong><span>Falta a data de nascimento</span></div>
          </div>
        ))}
        {notificationLists.missingBirthdays.length > 5 && <p className="notification-empty">E mais {notificationLists.missingBirthdays.length - 5} alunos.</p>}
      </NotificationGroup>}

      <div className="notifications-settings">
        <p className="dialog-note">Indicador no cabeçalho: {notificationsEnabled ? 'ativo' : 'inativo'}.</p>
        <button className="outline-button" onClick={onToggleNotifications}>{notificationsEnabled ? 'Desativar' : 'Ativar'}</button>
      </div>
    </div>}
    {type === 'profile' && <div className="dialog-copy"><div className="profile-dialog-avatar"><UserRound size={22} /></div><strong>{profile?.displayName || user?.displayName || user?.email}</strong><p>{profile?.status === 'admin' ? 'Administrador com acesso de gestão.' : 'Utilizador com acesso apenas de leitura.'}</p><button className="outline-button" onClick={onSignOut}>Terminar sessão</button></div>}
  </section></div>;
}

createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);