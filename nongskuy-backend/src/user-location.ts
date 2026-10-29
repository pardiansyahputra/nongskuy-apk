import { DurableObject } from 'cloudflare:workers';
import { validateLocation, sanitizeText, isValidNim } from './utils/security';

const STATUS_MAX_LENGTH = 60;
const STATUS_EXPIRY_MS = 2 * 60 * 60 * 1000;

export class UserLocation extends DurableObject {
	sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;

		this.sql.exec(`
      CREATE TABLE IF NOT EXISTS locations (
        user_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        faculty TEXT NOT NULL,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        is_active INTEGER DEFAULT 1,
        updated_at INTEGER NOT NULL
      )
    `);

		try {
			this.sql.exec(`ALTER TABLE locations ADD COLUMN status TEXT DEFAULT ''`);
		} catch {
			/* ada */
		}
		try {
			this.sql.exec(`ALTER TABLE locations ADD COLUMN status_updated_at INTEGER DEFAULT 0`);
		} catch {
			/* ada */
		}
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		// POST /update
		if (request.method === 'POST' && path === '/update') {
			try {
				const data = await request.json();
				const validation = validateLocation(data);
				if (!validation.ok) {
					return Response.json({ error: validation.error }, { status: 400 });
				}
				const clean = validation.data!;

				this.sql.exec(
					`INSERT OR REPLACE INTO locations 
           (user_id, name, faculty, latitude, longitude, is_active, updated_at, status, status_updated_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, 
             COALESCE((SELECT status FROM locations WHERE user_id = ?), ''),
             COALESCE((SELECT status_updated_at FROM locations WHERE user_id = ?), 0)
           )`,
					clean.user_id,
					clean.name,
					clean.faculty,
					clean.latitude,
					clean.longitude,
					Date.now(),
					clean.user_id,
					clean.user_id,
				);

				return Response.json({ ok: true, message: 'Location updated' });
			} catch {
				return Response.json({ error: 'Invalid JSON' }, { status: 400 });
			}
		}

		// POST /set-status
		if (request.method === 'POST' && path === '/set-status') {
			try {
				const data: any = await request.json();
				const { user_id, status } = data;

				const nimCheck = isValidNim(user_id);
				if (!nimCheck.ok) {
					return Response.json({ error: nimCheck.error }, { status: 400 });
				}

				let statusText = sanitizeText(status || '', STATUS_MAX_LENGTH);

				this.sql.exec(
					'UPDATE locations SET status = ?, status_updated_at = ? WHERE user_id = ?',
					statusText,
					statusText.length > 0 ? Date.now() : 0,
					user_id,
				);

				return Response.json({ ok: true, status: statusText });
			} catch {
				return Response.json({ error: 'Invalid JSON' }, { status: 400 });
			}
		}

		// POST /deactivate
		if (request.method === 'POST' && path === '/deactivate') {
			try {
				const { user_id } = (await request.json()) as any;
				const nimCheck = isValidNim(user_id);
				if (!nimCheck.ok) {
					return Response.json({ error: nimCheck.error }, { status: 400 });
				}
				this.sql.exec('UPDATE locations SET is_active = 0, status = "" WHERE user_id = ?', user_id);
				return Response.json({ ok: true });
			} catch {
				return Response.json({ error: 'Invalid JSON' }, { status: 400 });
			}
		}

		// POST /reset-all (admin/testing)
		if (request.method === 'POST' && path === '/reset-all') {
			try {
				this.sql.exec('DELETE FROM locations');
				return Response.json({ ok: true, message: 'Semua data dihapus' });
			} catch (e: any) {
				return Response.json({ error: e.message }, { status: 500 });
			}
		}

		// GET /active
		if (request.method === 'GET' && path === '/active') {
			const twoHoursAgo = Date.now() - STATUS_EXPIRY_MS;
			const rows = this.sql
				.exec(
					`SELECT user_id, name, faculty, latitude, longitude, is_active, updated_at,
                CASE WHEN status_updated_at > ? THEN status ELSE '' END as status,
                status_updated_at
         FROM locations WHERE is_active = 1`,
					twoHoursAgo,
				)
				.toArray();
			return Response.json({ users: rows, count: rows.length });
		}

		// GET /user/:id
		if (request.method === 'GET' && path.startsWith('/user/')) {
			const userId = path.split('/')[2];
			const nimCheck = isValidNim(userId);
			if (!nimCheck.ok) {
				return Response.json({ error: nimCheck.error }, { status: 400 });
			}
			const rows = this.sql.exec('SELECT * FROM locations WHERE user_id = ?', userId).toArray();
			if (rows.length === 0) {
				return Response.json({ error: 'User not found' }, { status: 404 });
			}
			return Response.json(rows[0]);
		}

		return new Response('Not Found', { status: 404 });
	}
}
