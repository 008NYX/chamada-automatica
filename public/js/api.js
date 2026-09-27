'use strict';

window.Api = (function () {
  async function request(url, options = {}) {
    const res = await fetch(url, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });

    let payload = null;
    try {
      payload = await res.json();
    } catch (_) {
      payload = null;
    }

    if (!res.ok) {
      const error = new Error((payload && payload.error) || `Erro HTTP ${res.status}`);
      error.status = res.status;
      throw error;
    }
    return payload;
  }

  return {
    config: () => request('/api/config'),
    health: () => request('/api/health'),

    me: () => request('/api/auth/me'),
    login: (password) =>
      request('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) }),
    logout: () => request('/api/auth/logout', { method: 'POST' }),

    listUsers: () => request('/api/users'),
    getUser: (id) => request(`/api/users/${id}`),
    createUser: (data) => request('/api/users', { method: 'POST', body: JSON.stringify(data) }),
    updateUser: (id, data) =>
      request(`/api/users/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteUser: (id) => request(`/api/users/${id}`, { method: 'DELETE' }),

    todaySheet: (classroom) =>
      request(`/api/attendance/today?classroom=${encodeURIComponent(classroom)}`),
    rooms: () => request('/api/attendance/rooms'),
    markPresent: (studentId) =>
      request('/api/attendance/mark', { method: 'POST', body: JSON.stringify({ studentId }) }),

    getGlassesModel: () => request('/api/glasses-model'),
    saveGlassesModel: (model) =>
      request('/api/glasses-model', { method: 'PUT', body: JSON.stringify({ model }) }),
    deleteGlassesModel: () => request('/api/glasses-model', { method: 'DELETE' }),
  };
})();
