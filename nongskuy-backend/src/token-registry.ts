import { DurableObject } from 'cloudflare:workers';

export class TokenRegistry extends DurableObject {
	sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;

		this.sql.exec(`
      CREATE TABLE IF NOT EXISTS tokens (
        user_id TEXT PRIMARY KEY,
        token TEXT NOT NULL,
        platform TEXT DEFAULT 'android',
        updated_at INTEGER NOT NULL
      )
    `);
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		// POST /register
		if (request.method === 'POST' && path === '/register') {
			try {
				const data: any = await request.json();
				const { user_id, token, platform } = data;

				if (!user_id || !token) {
					return Response.json({ error: 'user_id & token required' }, { status: 400 });
				}

				this.sql.exec(
					`INSERT OR REPLACE INTO tokens (user_id, token, platform, updated_at)
           VALUES (?, ?, ?, ?)`,
					user_id,
					token,
					platform || 'android',
					Date.now(),
				);

				return Response.json({ ok: true });
			} catch {
				return Response.json({ error: 'Invalid JSON' }, { status: 400 });
			}
		}

		// GET /tokens/{user_id}
		if (request.method === 'GET' && path.startsWith('/tokens/')) {
			const userId = path.split('/')[2];
			const rows = this.sql.exec('SELECT * FROM tokens WHERE user_id = ?', userId).toArray();

			if (rows.length === 0) {
				return Response.json({ token: null }, { status: 404 });
			}

			return Response.json(rows[0]);
		}

		// POST /remove
		if (request.method === 'POST' && path === '/remove') {
			try {
				const data: any = await request.json();
				const { user_id } = data;

				if (!user_id) {
					return Response.json({ error: 'user_id required' }, { status: 400 });
				}

				this.sql.exec('DELETE FROM tokens WHERE user_id = ?', user_id);
				return Response.json({ ok: true });
			} catch {
				return Response.json({ error: 'Invalid JSON' }, { status: 400 });
			}
		}

		// POST /all-except
		if (request.method === 'POST' && path === '/all-except') {
			try {
				const data: any = await request.json();
				const { exclude_user_id } = data;

				let rows;
				if (exclude_user_id) {
					rows = this.sql.exec('SELECT user_id, token FROM tokens WHERE user_id != ?', exclude_user_id).toArray();
				} else {
					rows = this.sql.exec('SELECT user_id, token FROM tokens').toArray();
				}

				return Response.json({ tokens: rows });
			} catch {
				return Response.json({ error: 'Invalid JSON' }, { status: 400 });
			}
		}

		// POST /all — ambil semua token
		if (request.method === 'POST' && path === '/all') {
			const rows = this.sql.exec('SELECT user_id, token FROM tokens').toArray();
			return Response.json({ tokens: rows });
		}

		return new Response('Not Found', { status: 404 });
	}
}
