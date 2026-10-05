import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../../src/app.js';
import { Problem } from '../../src/http/problem.js';
import { usersRoutes } from '../../src/routes/users.js';
import { User, UserPage } from '../../src/schemas/user.js';

const alice = { email: 'alice@example.com', name: 'Alice' };
const missing = '5f0c6b9e-6d5a-4c1b-9a51-0f5c1c9d2e11';

let app: App;
beforeEach(() => {
  app = createApp(usersRoutes());
});

async function create(body: object = alice) {
  return User.parse((await request(app).post('/v1/users').send(body)).body);
}

function problemOf(res: request.Response, status: number) {
  expect(res.status).toBe(status);
  expect(res.get('Content-Type')).toMatch(/^application\/problem\+json/);
  return Problem.parse(res.body);
}

describe('users', () => {
  it('creates: 201 with Location', async () => {
    const res = await request(app).post('/v1/users').send(alice);
    expect(res.status).toBe(201);
    const user = User.parse(res.body);
    expect(user).toMatchObject(alice);
    expect(res.get('Location')).toBe(`/v1/users/${user.id}`);
  });

  it('409s a duplicate email on create and update', async () => {
    const a = await create();
    const b = await create({ email: 'bob@example.com', name: 'Bob' });
    expect(problemOf(await request(app).post('/v1/users').send(alice), 409).instance).toBe('/v1/users');
    problemOf(await request(app).patch(`/v1/users/${b.id}`).send({ email: a.email }), 409);
  });

  it('422s invalid bodies', async () => {
    expect(problemOf(await request(app).post('/v1/users').send({ email: 'x' }), 422).detail).toMatch(/email/);
  });

  it('gets, updates and deletes', async () => {
    const user = await create();
    expect(User.parse((await request(app).get(`/v1/users/${user.id}`)).body)).toEqual(user);
    expect(User.parse((await request(app).patch(`/v1/users/${user.id}`).send({ name: 'Al' })).body).name).toBe('Al');
    const del = await request(app).delete(`/v1/users/${user.id}`);
    expect(del.status).toBe(204);
    expect(del.text).toBe('');
    problemOf(await request(app).get(`/v1/users/${user.id}`), 404);
  });

  it('404s unknown ids on get, update and delete', async () => {
    problemOf(await request(app).get(`/v1/users/${missing}`), 404);
    problemOf(await request(app).patch(`/v1/users/${missing}`).send({ name: 'x' }), 404);
    problemOf(await request(app).delete(`/v1/users/${missing}`), 404);
  });

  it('lists with cursor pagination', async () => {
    for (const n of [1, 2, 3]) await create({ email: `u${n}@example.com`, name: `U${n}` });
    const first = UserPage.parse((await request(app).get('/v1/users?limit=2')).body);
    expect(first.data).toHaveLength(2);
    const second = UserPage.parse((await request(app).get('/v1/users').query({ limit: 2, cursor: first.nextCursor ?? '' })).body);
    expect(second.data.map((u) => u.name)).toEqual(['U3']);
    expect(second.nextCursor).toBeNull();
    problemOf(await request(app).get('/v1/users?limit=0'), 422);
    problemOf(await request(app).get('/v1/users?cursor=garbage!'), 422);
  });

  it('is registered in the default app', async () => {
    expect(createApp().routeTable.map((r) => `${r.method} ${r.path}`)).toContain('post /v1/users');
  });
});
