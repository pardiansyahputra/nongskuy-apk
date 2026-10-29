import { DurableObject } from 'cloudflare:workers';
import { validateGroupName, validateMembers, isValidNim, sanitizeText } from './utils/security';

export class GroupRegistry extends DurableObject {
	sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;

		this.sql.exec(`
      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        members TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);

		try {
			this.sql.exec(`ALTER TABLE groups ADD COLUMN icon TEXT DEFAULT '👥'`);
		} catch {
			/* sudah ada */
		}
		try {
			this.sql.exec(`ALTER TABLE groups ADD COLUMN last_active_at INTEGER DEFAULT 0`);
		} catch {
			/* sudah ada */
		}

		// Set last_active_at untuk grup lama
		try {
			this.sql.exec(`UPDATE groups SET last_active_at = created_at WHERE last_active_at = 0`);
		} catch {
			/* ignore */
		}
	}

	private touch(groupId: string) {
		try {
			this.sql.exec('UPDATE groups SET last_active_at = ? WHERE id = ?', Date.now(), groupId);
		} catch {
			/* ignore */
		}
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		// === POST /create ===
		if (request.method === 'POST' && path === '/create') {
			try {
				const data: any = await request.json();
				const { name, owner_id, members } = data;

				// Validate owner_id
				const ownerCheck = isValidNim(owner_id);
				if (!ownerCheck.ok) {
					return Response.json({ error: 'Owner NIM tidak valid' }, { status: 400 });
				}

				// Validate name
				const nameCheck = validateGroupName(name);
				if (!nameCheck.ok) {
					return Response.json({ error: nameCheck.error }, { status: 400 });
				}

				// Validate members
				const membersCheck = validateMembers(members || []);
				if (!membersCheck.ok) {
					return Response.json({ error: membersCheck.error }, { status: 400 });
				}

				const groupId = `g${Date.now()}${Math.floor(Math.random() * 1000)}`;
				const allMembers = Array.from(new Set([owner_id, ...membersCheck.value!]));
				const groupIcon = typeof data.icon === 'string' && data.icon.length > 0 ? data.icon : '👥';
				const now = Date.now();

				this.sql.exec(
					'INSERT INTO groups (id, name, owner_id, members, icon, created_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
					groupId,
					nameCheck.value!,
					owner_id,
					JSON.stringify(allMembers),
					groupIcon,
					now,
					now,
				);

				return Response.json({ ok: true, group_id: groupId });
			} catch {
				return Response.json({ error: 'Invalid JSON' }, { status: 400 });
			}
		}

		// === GET /list ===
		if (request.method === 'GET' && path === '/list') {
			const userId = url.searchParams.get('user_id');
			const nimCheck = isValidNim(userId);
			if (!nimCheck.ok) {
				return Response.json({ error: 'user_id tidak valid' }, { status: 400 });
			}

			const rows = this.sql.exec('SELECT * FROM groups').toArray();
			const userGroups = rows.filter((row: any) => {
				try {
					return JSON.parse(row.members).includes(userId);
				} catch {
					return false;
				}
			});

			const groups = userGroups.map((row: any) => ({
				id: row.id,
				name: row.name,
				owner_id: row.owner_id,
				members: JSON.parse(row.members),
				member_count: JSON.parse(row.members).length,
				icon: row.icon || '👥',
				created_at: row.created_at,
			}));

			return Response.json({ groups, count: groups.length });
		}

		// === GET /detail/:id ===
		if (request.method === 'GET' && path.startsWith('/detail/')) {
			const groupId = path.split('/')[2];
			const rows = this.sql.exec('SELECT * FROM groups WHERE id = ?', groupId).toArray();
			if (rows.length === 0) {
				return Response.json({ error: 'Group not found' }, { status: 404 });
			}
			const row: any = rows[0];
			this.touch(groupId);
			return Response.json({
				id: row.id,
				name: row.name,
				owner_id: row.owner_id,
				members: JSON.parse(row.members),
				member_count: JSON.parse(row.members).length,
				icon: row.icon || '👥',
				created_at: row.created_at,
			});
		}

		// === POST /touch — update aktivitas ===
		if (request.method === 'POST' && path === '/touch') {
			try {
				const { group_id } = (await request.json()) as any;
				if (group_id) this.touch(group_id);
				return Response.json({ ok: true });
			} catch {
				return Response.json({ error: 'Invalid JSON' }, { status: 400 });
			}
		}

		// === POST /rename ===
		if (request.method === 'POST' && path === '/rename') {
			try {
				const data: any = await request.json();
				const { group_id, name, user_id } = data;

				const nameCheck = validateGroupName(name);
				if (!nameCheck.ok) {
					return Response.json({ error: nameCheck.error }, { status: 400 });
				}
				const nimCheck = isValidNim(user_id);
				if (!nimCheck.ok) {
					return Response.json({ error: 'user_id tidak valid' }, { status: 400 });
				}

				const rows = this.sql.exec('SELECT * FROM groups WHERE id = ?', group_id).toArray();
				if (rows.length === 0) {
					return Response.json({ error: 'Group not found' }, { status: 404 });
				}
				const group: any = rows[0];
				if (group.owner_id !== user_id) {
					return Response.json({ error: 'Hanya owner yang bisa rename' }, { status: 403 });
				}

				this.sql.exec('UPDATE groups SET name = ? WHERE id = ?', nameCheck.value!, group_id);
				this.touch(group_id);
				return Response.json({ ok: true, name: nameCheck.value });
			} catch {
				return Response.json({ error: 'Invalid JSON' }, { status: 400 });
			}
		}

		// === POST /update-icon ===
		if (request.method === 'POST' && path === '/update-icon') {
			try {
				const data: any = await request.json();
				const { group_id, icon, user_id } = data;
				if (!group_id || !icon) {
					return Response.json({ error: 'group_id, icon required' }, { status: 400 });
				}
				if (icon.length > 8) {
					return Response.json({ error: 'Icon tidak valid' }, { status: 400 });
				}
				const rows = this.sql.exec('SELECT * FROM groups WHERE id = ?', group_id).toArray();
				if (rows.length === 0) {
					return Response.json({ error: 'Group not found' }, { status: 404 });
				}
				const row: any = rows[0];
				if (user_id && row.owner_id !== user_id) {
					return Response.json({ error: 'Hanya owner yang bisa ganti icon' }, { status: 403 });
				}
				this.sql.exec('UPDATE groups SET icon = ? WHERE id = ?', icon, group_id);
				this.touch(group_id);
				return Response.json({ ok: true, icon });
			} catch {
				return Response.json({ error: 'Invalid JSON' }, { status: 400 });
			}
		}

		// === POST /invite ===
		if (request.method === 'POST' && path === '/invite') {
			try {
				const data: any = await request.json();
				const { group_id, user_id } = data;

				if (!group_id) {
					return Response.json({ error: 'group_id required' }, { status: 400 });
				}
				const nimCheck = isValidNim(user_id);
				if (!nimCheck.ok) {
					return Response.json({ error: nimCheck.error }, { status: 400 });
				}

				const rows = this.sql.exec('SELECT * FROM groups WHERE id = ?', group_id).toArray();
				if (rows.length === 0) {
					return Response.json({ error: 'Group not found' }, { status: 404 });
				}
				const row: any = rows[0];
				const members: string[] = JSON.parse(row.members);
				if (members.length >= 50) {
					return Response.json({ error: 'Grup sudah penuh (max 50)' }, { status: 400 });
				}

				if (!members.includes(user_id)) {
					members.push(user_id);
					this.sql.exec('UPDATE groups SET members = ? WHERE id = ?', JSON.stringify(members), group_id);

					const env = this.env as Env;
					this.ctx.waitUntil(
						(async () => {
							try {
								const { sendFcmToUser } = await import('./fcm-helper');
								await sendFcmToUser(env, user_id, '👥 Kamu diundang ke grup', `Kamu ditambahkan ke grup "${row.name}"`, {
									type: 'invite',
									groupId: group_id,
								});
							} catch (e) {
								console.error('[FCM Invite] Error:', e);
							}
						})(),
					);
				}
				this.touch(group_id);
				return Response.json({ ok: true, members });
			} catch {
				return Response.json({ error: 'Invalid JSON' }, { status: 400 });
			}
		}

		// === POST /leave ===
		if (request.method === 'POST' && path === '/leave') {
			try {
				const data: any = await request.json();
				const { group_id, user_id } = data;

				if (!group_id) {
					return Response.json({ error: 'group_id required' }, { status: 400 });
				}
				const nimCheck = isValidNim(user_id);
				if (!nimCheck.ok) {
					return Response.json({ error: nimCheck.error }, { status: 400 });
				}

				const rows = this.sql.exec('SELECT * FROM groups WHERE id = ?', group_id).toArray();
				if (rows.length === 0) {
					return Response.json({ error: 'Group not found' }, { status: 404 });
				}
				const row: any = rows[0];
				let members: string[] = JSON.parse(row.members);
				members = members.filter((m) => m !== user_id);

				if (members.length === 0) {
					this.sql.exec('DELETE FROM groups WHERE id = ?', group_id);
					return Response.json({ ok: true, deleted: true });
				}
				this.sql.exec('UPDATE groups SET members = ? WHERE id = ?', JSON.stringify(members), group_id);
				this.touch(group_id);
				return Response.json({ ok: true, members });
			} catch {
				return Response.json({ error: 'Invalid JSON' }, { status: 400 });
			}
		}

		// === POST /cleanup-inactive — hapus grup dengan 1 anggota tidak aktif 30 hari ===
		if (request.method === 'POST' && path === '/cleanup-inactive') {
			const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
			let deletedCount = 0;

			try {
				const inactiveRows = this.sql.exec('SELECT id, members FROM groups WHERE last_active_at < ?', thirtyDaysAgo).toArray();

				for (const row of inactiveRows) {
					const members = JSON.parse((row as any).members);
					if (members.length <= 1) {
						this.sql.exec('DELETE FROM groups WHERE id = ?', (row as any).id);
						deletedCount++;
					}
				}
				console.log(`[Cleanup] ${deletedCount} grup tidak aktif dihapus`);
				return Response.json({ ok: true, deleted: deletedCount });
			} catch (e: any) {
				return Response.json({ error: e.message }, { status: 500 });
			}
		}

		return new Response('Not Found', { status: 404 });
	}
}
