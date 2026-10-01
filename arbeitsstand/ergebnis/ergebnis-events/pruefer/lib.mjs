export const API = 'http://localhost:8080/api/v1';
export async function call(method, path, token, body) {
  const r = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j };
}
export async function konto(prefix) {
  const s = Math.random().toString(36).slice(2, 8);
  const r = await call('POST', '/auth/register', null, { username: `${prefix}${s}`, password: 'passwort123', displayName: `${prefix} ${s}` });
  if (r.status !== 201) throw new Error('reg ' + JSON.stringify(r));
  return { token: r.body.accessToken, id: r.body.user.id, name: `${prefix}${s}` };
}
export const in3Tagen = () => { const b = new Date(Date.now() + 3 * 864e5); return { startsAt: b.toISOString(), endsAt: new Date(+b + 36e5).toISOString() }; };
export async function msgs(k, chat) { return (await call('GET', `/conversations/${chat}/messages`, k.token)).body.items; }
