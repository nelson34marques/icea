export const API_URL = (import.meta.env.VITE_API_URL || 'https://ebd-api-n7xg.onrender.com').replace(/\/$/, '');

const REQUEST_TIMEOUT = 45000;

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

async function request(path) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  let response;
  try {
    response = await fetch(`${API_URL}${path}`, { signal: controller.signal, headers: { Accept: 'application/json' } });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('O carregamento está a demorar mais do que o normal. Tente novamente daqui a pouco.');
    throw new Error('Não foi possível carregar os dados. Verifique a ligação e tente novamente.');
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 404) throw new Error('Algumas informações ainda não estão disponíveis. Tente novamente mais tarde.');
  if (!response.ok) throw new Error('Não foi possível atualizar os dados. Tente novamente daqui a pouco.');
  try {
    return await response.json();
  } catch {
    throw new Error('Recebemos uma resposta inesperada. Tente novamente mais tarde.');
  }
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

async function fetchVisitors(sessions) {
  const completeSessions = await Promise.all(sessions.map(async (session) => {
    if (!session.id) return session;
    try {
      return await request(`/sessions/${encodeURIComponent(session.id)}`);
    } catch {
      return session;
    }
  }));

  return completeSessions.flatMap((session) => (session.visitantes || session.visitors || []).map((visitor) => {
    const name = firstValue(visitor.name, visitor.nome) || 'Visitante sem nome';
    return {
      ...visitor,
      name,
      initials: firstValue(visitor.initials, visitor.iniciais) || initialsOf(name),
      date: formatDate(firstValue(visitor.date, visitor.data, session.date, session.data)),
      className: firstValue(visitor.className, visitor.turma, session.class_name, session.turma) || 'Visitante',
    };
  }));
}

export const api = {
  async getDashboard() {
    const [stats, classes, members, sessions] = await Promise.all([
      request('/stats'),
      request('/classes').then(normalizeClasses),
      request('/members').then(normalizeMembers),
      fetchSessions(),
    ]);

    return {
      stats: stats && !Array.isArray(stats) ? stats : {},
      classes,
      members,
      sessions,
      visitors: await fetchVisitors(sessions),
    };
  },
};