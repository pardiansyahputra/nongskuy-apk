import { DurableObject } from 'cloudflare:workers';
import { sanitizeText, isValidNim } from './utils/security';

export class MeetupRegistry extends DurableObject {
	sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;

		this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meetups (
        id TEXT PRIMARY KEY, group_id TEXT NOT NULL, creator_id TEXT NOT NULL,
        title TEXT NOT NULL, location_name TEXT DEFAULT '',
        latitude REAL NOT NULL, longitude REAL NOT NULL,
        meetup_time INTEGER NOT NULL, created_at INTEGER NOT NULL,
        is_active INTEGER DEFAULT 1
      )
    `);

		this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meetup_votes (
        meetup_id TEXT NOT NULL, user_id TEXT NOT NULL,
        status TEXT NOT NULL, voted_at INTEGER NOT NULL,
        PRIMARY KEY (meetup_id, user_id)
      )
    `);

		this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_meetup_group ON meetups(group_id)`);
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		// POST /create
		if (request.method === 'POST' && path === '/create') {
			try {
				const data: any = await request.json();
				const { group_id, creator_id, title, location_name, latitude, longitude, meetup_time } = data;

				const creatorCheck = isValidNim(creator_id);
				if (!creatorCheck.ok) {
					return Response.json({ error: creatorCheck.error }, { status: 400 });
				}
				if (!group_id || typeof group_id !== 'string') {
					return Response.json({ error: 'group_id required' }, { status: 400 });
				}
				const cleanTitle = sanitizeText(title, 80);
				if (!cleanTitle) {
					return Response.json({ error: 'Judul wajib diisi (max 80)' }, { status: 400 });
				}
				if (typeof latitude !== 'number' || typeof longitude !== 'number') {
					return Response.json({ error: 'Koordinat tidak valid' }, { status: 400 });
				}
				if (!meetup_time || typeof meetup_time !== 'number') {
					return Response.json({ error: 'Waktu wajib diisi' }, { status: 400 });
				}

				const meetupId = `m${Date.now()}${Math.floor(Math.random() * 1000)}`;
				const cleanLocation = sanitizeText(location_name || '', 100);

				this.sql.exec(
					`INSERT INTO meetups (id, group_id, creator_id, title, location_name, latitude, longitude, meetup_time, created_at, is_active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
					meetupId,
					group_id,
					creator_id,
					cleanTitle,
					cleanLocation,
					latitude,
					longitude,
					meetup_time,
					Date.now(),
				);

				this.sql.exec(
					`INSERT OR REPLACE INTO meetup_votes (meetup_id, user_id, status, voted_at) VALUES (?, ?, 'going', ?)`,
					meetupId,
					creator_id,
					Date.now(),
				);

				const env = this.env as Env;
				this.ctx.waitUntil(
					(async () => {
						try {
							const groupRegistryId = env.GROUP_REGISTRY.idFromName('global');
							const groupStub = env.GROUP_REGISTRY.get(groupRegistryId);
							const groupResp = await groupStub.fetch(new Request(`http://x/detail/${group_id}`));
							if (!groupResp.ok) return;
							const group: any = await groupResp.json();
							const members: string[] = group.members || [];
							const targets = members.filter((m) => m !== creator_id);
							if (targets.length === 0) return;

							const { sendFcmToUsers } = await import('./fcm-helper');
							const date = new Date(meetup_time);
							const dateStr = date.toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
							await sendFcmToUsers(env, targets, '🎉 Meetup Baru', `${cleanTitle} • ${dateStr}`, {
								type: 'meetup',
								meetupId,
								groupId: group_id,
							});
						} catch (e) {
							console.error('[FCM Meetup]', e);
						}
					})(),
				);

				return Response.json({ ok: true, meetup_id: meetupId });
			} catch {
				return Response.json({ error: 'Invalid JSON' }, { status: 400 });
			}
		}

		// GET /list?group_id=X
		if (request.method === 'GET' && path === '/list') {
			const groupId = url.searchParams.get('group_id');
			if (!groupId) return Response.json({ error: 'group_id required' }, { status: 400 });
			const rows = this.sql.exec('SELECT * FROM meetups WHERE group_id = ? AND is_active = 1 ORDER BY meetup_time ASC', groupId).toArray();
			const meetups = rows.map((row: any) => this.enrichMeetup(row));
			return Response.json({ meetups, count: meetups.length });
		}

		// POST /list-by-groups
		if (request.method === 'POST' && path === '/list-by-groups') {
			try {
				const data: any = await request.json();
				const { group_ids, only_upcoming } = data;
				if (!Array.isArray(group_ids) || group_ids.length === 0) {
					return Response.json({ meetups: [], count: 0 });
				}
				const placeholders = group_ids.map(() => '?').join(',');
				let query = `SELECT * FROM meetups WHERE group_id IN (${placeholders}) AND is_active = 1`;
				const args: any[] = [...group_ids];
				if (only_upcoming) {
					query += ` AND meetup_time > ?`;
					args.push(Date.now());
				}
				query += ` ORDER BY meetup_time ASC`;
				const rows = this.sql.exec(query, ...args).toArray();
				const meetups = rows.map((row: any) => this.enrichMeetup(row));
				return Response.json({ meetups, count: meetups.length });
			} catch {
				return Response.json({ error: 'Invalid JSON' }, { status: 400 });
			}
		}

		// GET /detail/:id
		if (request.method === 'GET' && path.startsWith('/detail/')) {
			const meetupId = path.split('/')[2];
			const rows = this.sql.exec('SELECT * FROM meetups WHERE id = ?', meetupId).toArray();
			if (rows.length === 0) return Response.json({ error: 'Not found' }, { status: 404 });
			return Response.json(this.enrichMeetup(rows[0] as any));
		}

		// POST /vote
		if (request.method === 'POST' && path === '/vote') {
			try {
				const data: any = await request.json();
				const { meetup_id, user_id, status } = data;
				if (!meetup_id || !user_id || !status) {
					return Response.json({ error: 'meetup_id, user_id, status required' }, { status: 400 });
				}
				const nimCheck = isValidNim(user_id);
				if (!nimCheck.ok) return Response.json({ error: nimCheck.error }, { status: 400 });
				if (!['going', 'not_going', 'arrived'].includes(status)) {
					return Response.json({ error: 'Status tidak valid' }, { status: 400 });
				}
				const rows = this.sql.exec('SELECT * FROM meetups WHERE id = ?', meetup_id).toArray();
				if (rows.length === 0) return Response.json({ error: 'Not found' }, { status: 404 });
				this.sql.exec(
					`INSERT OR REPLACE INTO meetup_votes (meetup_id, user_id, status, voted_at) VALUES (?, ?, ?, ?)`,
					meetup_id,
					user_id,
					status,
					Date.now(),
				);
				return Response.json({ ok: true, status });
			} catch {
				return Response.json({ error: 'Invalid JSON' }, { status: 400 });
			}
		}

		// GET /votes/:id
		if (request.method === 'GET' && path.startsWith('/votes/')) {
			const meetupId = path.split('/')[2];
			const rows = this.sql.exec('SELECT user_id, status FROM meetup_votes WHERE meetup_id = ?', meetupId).toArray();
			const going: string[] = [];
			const notGoing: string[] = [];
			const arrived: string[] = [];
			rows.forEach((row: any) => {
				if (row.status === 'going') going.push(row.user_id);
				else if (row.status === 'not_going') notGoing.push(row.user_id);
				else if (row.status === 'arrived') arrived.push(row.user_id);
			});
			return Response.json({ going, not_going: notGoing, arrived, total: rows.length });
		}

		// POST /cancel
		if (request.method === 'POST' && path === '/cancel') {
			try {
				const data: any = await request.json();
				const { meetup_id, user_id } = data;
				if (!meetup_id || !user_id) return Response.json({ error: 'required' }, { status: 400 });
				const nimCheck = isValidNim(user_id);
				if (!nimCheck.ok) return Response.json({ error: nimCheck.error }, { status: 400 });
				const rows = this.sql.exec('SELECT * FROM meetups WHERE id = ?', meetup_id).toArray();
				if (rows.length === 0) return Response.json({ error: 'Not found' }, { status: 404 });
				const meetup: any = rows[0];
				if (meetup.creator_id !== user_id) {
					return Response.json({ error: 'Hanya creator bisa cancel' }, { status: 403 });
				}
				this.sql.exec('UPDATE meetups SET is_active = 0 WHERE id = ?', meetup_id);
				return Response.json({ ok: true });
			} catch {
				return Response.json({ error: 'Invalid JSON' }, { status: 400 });
			}
		}

		return new Response('Not Found', { status: 404 });
	}

	private enrichMeetup(row: any): any {
		const votes = this.sql.exec('SELECT user_id, status FROM meetup_votes WHERE meetup_id = ?', row.id).toArray();
		const going: string[] = [];
		const notGoing: string[] = [];
		const arrived: string[] = [];
		votes.forEach((v: any) => {
			if (v.status === 'going') going.push(v.user_id);
			else if (v.status === 'not_going') notGoing.push(v.user_id);
			else if (v.status === 'arrived') arrived.push(v.user_id);
		});
		return {
			id: row.id,
			group_id: row.group_id,
			creator_id: row.creator_id,
			title: row.title,
			location_name: row.location_name,
			latitude: row.latitude,
			longitude: row.longitude,
			meetup_time: row.meetup_time,
			created_at: row.created_at,
			is_active: row.is_active,
			going,
			not_going: notGoing,
			arrived,
			going_count: going.length + arrived.length,
			arrived_count: arrived.length,
		};
	}
}
