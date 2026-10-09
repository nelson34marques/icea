import { auth } from './firebase';

export const API_URL = (import.meta.env.VITE_API_URL || 'https://ebd-api-n7xg.onrender.com').replace(/\/$/, '');

const REQUEST_TIMEOUT = 45000;

async function authHeader() {
  const user = auth.currentUser;
  if (!user) throw Object.assign(new Error('Sessão terminada. Inicie sessão novamente.'), { sessao: true });
  const token = await user.getIdToken();
  if (!token) throw Object.assign(new Error('Não foi possível validar a sessão. Inicie sessão novamente.'), { sessao: true });
  return { Authorization: `Bearer ${token}` };
}

function listFrom(payload, key) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload[key])) return payload[key];
  if (payload && Array.isArray(payload.value)) return payload.value;
  return [];
}

function formatDate(iso) {
  if (!iso) return '';
  const [year, month, day] = String(iso).slice(0, 10).split('-');
  return year && month && day ? `${day}/${month}/${year}` : iso;
}

function initialsOf(name) {
  return String(name || '').split(' ').map((part) => part[0]).slice(0, 2).join('').toUpperCase();
}

function firstValue(...candidates) {
  return candidates.find((candidate) => candidate !== undefined && candidate !== null && candidate !== '');
}

function statusMessage(status, fallback) {
  if (status === 401) return 'Sessão expirada ou não autorizada. Inicie sessão novamente.';
  if (status === 403) return 'A sua conta não tem permissão para aceder a estes dados.';
  if (status === 404) return 'Algumas informações ainda não estão disponíveis. Tente novamente mais tarde.';
  if (status === 429) return 'Muitas tentativas seguidas. Aguarde um instante e tente novamente.';
  if (status === 503) return 'A API está a reiniciar. Tente novamente dentro de alguns segundos.';
  return fallback;
}

async function request(path) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  let response;
  try {
    const authHeaders = await authHeader();
    response = await fetch(`${API_URL}${path}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json', ...authHeaders },
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('O carregamento está a demorar mais do que o normal. Tente novamente daqui a pouco.');
    if (error?.sessao) throw error;
    throw new Error('Não foi possível carregar os dados. Verifique a ligação e tente novamente.');
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) throw new Error(statusMessage(response.status, 'Não foi possível atualizar os dados. Tente novamente daqui a pouco.'));
  try {
    return await response.json();
  } catch {
    throw new Error('Recebemos uma resposta inesperada. Tente novamente mais tarde.');
  }
}

async function enviar(path, corpo) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  let response;
  try {
    const authHeaders = await authHeader();
    response = await fetch(`${API_URL}${path}`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...authHeaders },
      body: JSON.stringify(corpo),
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('A gravação está a demorar mais do que o normal. Tente novamente.');
    if (error?.sessao) throw error;
    throw new Error('Não foi possível guardar. Verifique a ligação e tente novamente.');
  } finally {
    clearTimeout(timeout);
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw new Error(payload?.erro || statusMessage(response.status, 'Não foi possível guardar. Tente novamente daqui a pouco.'));
  }
  return payload;
}

async function fetchSessions() {
  return listFrom(await request('/sessions'), 'sessions');
}

function normalizeClasses(payload) {
  return listFrom(payload, 'classes').map((item) => ({
    ...item,
    name: firstValue(item.name, item.nome, item.turma) || 'Turma sem nome',
    color: item.color || null,
  }));
}

function normalizeMembers(payload) {
  return listFrom(payload, 'members').map((person) => {
    const name = firstValue(person.name, person.nome) || 'Pessoa sem nome';
    return {
      ...person,
      name,
      initials: firstValue(person.initials, person.iniciais) || initialsOf(name),
      class_id: firstValue(person.class_id, person.classId, person.turma_id, person.turmaId),
      status: firstValue(person.status, person.presenca, person.estado),
    };
  });
}

async function fetchVisitors() {
  return listFrom(await request('/visitors'), 'visitors').map((visitor) => {
    const name = firstValue(visitor.name, visitor.nome) || 'Visitante sem nome';
    return {
      ...visitor,
      name,
      initials: firstValue(visitor.initials, visitor.iniciais) || initialsOf(name),
      date: formatDate(firstValue(visitor.date, visitor.data)),
      className: firstValue(visitor.className, visitor.turma) || 'Visitante',
      classId: firstValue(visitor.classId, visitor.class_id),
    };
  });
}

async function fetchAttendance() {
  return listFrom(await request('/attendance'), 'attendance').map((record) => ({
    ...record,
    classId: firstValue(record.classId, record.class_id),
    sessionDate: firstValue(record.sessionDate, record.session_date, record.date),
    attendance: Array.isArray(record.attendance) ? record.attendance : [],
  }));
}

async function fetchMemberPhoto(memberId) {
  const authHeaders = await authHeader();
  let response;
  try {
    response = await fetch(`${API_URL}/members/${encodeURIComponent(memberId)}/photo`, {
      headers: { Accept: 'application/json', ...authHeaders },
    });
  } catch {
    throw new Error('Não foi possível carregar a foto. Verifique a ligação.');
  }
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(statusMessage(response.status, 'Não foi possível carregar a foto.'));
  try {
    const payload = await response.json();
    return payload?.photo || null;
  } catch {
    throw new Error('Recebemos uma resposta inesperada ao carregar a foto.');
  }
}

async function fetchMemberPhotos() {
  const payload = await request('/members/photos');
  return payload && !Array.isArray(payload) && typeof payload === 'object' ? payload : {};
}

export const api = {
  async getDashboard() {
    const [stats, classes, members, sessions, visitors, attendanceRecords] = await Promise.all([
      request('/stats'),
      request('/classes').then(normalizeClasses),
      request('/members').then(normalizeMembers),
      fetchSessions(),
      fetchVisitors(),
      fetchAttendance(),
    ]);

    return {
      stats: stats && !Array.isArray(stats) ? stats : {},
      classes,
      members,
      sessions,
      visitors,
      attendanceRecords,
    };
  },

  criarVisitante({ name, classId, date }) {
    return enviar('/visitors', { name, classId, date });
  },

  criarAluno({ name, birth_date }) {
    return enviar('/members', { name, birth_date, role: 'Aluno' });
  },

  guardarPresencas({ classId, date, attendance }) {
    return enviar('/attendance', { classId, date, attendance });
  },

  guardarFoto(memberId, photo) {
    return enviar(`/members/${encodeURIComponent(memberId)}/photo`, { photo });
  },

  carregarFoto(memberId) {
    return fetchMemberPhoto(memberId);
  },

  carregarFotos() {
    return fetchMemberPhotos();
  },
};