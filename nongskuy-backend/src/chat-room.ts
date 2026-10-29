import { DurableObject } from 'cloudflare:workers';
import { validateMessage } from './utils/security';
import { checkRateLimit } from './utils/rate-limiter';

interface ChatMessage {
	sender: string;
	content: string;
	type: string;
	reply_to_id?: number;
}

export class ChatRoom extends DurableObject {
	sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;

		this.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender TEXT NOT NULL,
        content TEXT NOT NULL,
        type TEXT DEFAULT 'text',
        created_at INTEGER NOT NULL
      )
    `);

		try {
			this.sql.exec('ALTER TABLE messages ADD COLUMN reply_to_id INTEGER DEFAULT NULL');
		} catch {
			/* ada */
		}
		try {
			this.sql.exec('ALTER TABLE messages ADD COLUMN is_deleted INTEGER DEFAULT 0');
		} catch {
			/* ada */
		}

		this.scheduleCleanup();
	}

	private scheduleCleanup() {
		this.ctx.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000);
	}

	async alarm() {
		const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000;
		try {
			this.sql.exec('DELETE FROM messages WHERE created_at < ?', cutoff);
			console.log('[ChatRoom] Cleanup');
		} catch (e) {
			console.error('[ChatRoom] Cleanup error:', e);
		}
		this.scheduleCleanup();
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		// === Set roomId ===
		if (request.method === 'POST' && path === '/set-room-id') {
			try {
				const data: any = await request.json();
				if (data.roomId) {
					await this.ctx.storage.put('roomId', data.roomId);
				}
				if (data.userId) {
					await this.ctx.storage.put('lastVerifiedUserId', data.userId);
				}
				return Response.json({ ok: true });
			} catch {
				return Response.json({ error: 'Invalid JSON' }, { status: 400 });
			}
		}

		// === Clear All ===
		if (request.method === 'POST' && path === '/clear-all') {
			try {
				this.sql.exec('DELETE FROM messages');
				return Response.json({ ok: true });
			} catch (e: any) {
				return Response.json({ error: e.message }, { status: 500 });
			}
		}

		// === WebSocket ===
		const upgradeHeader = request.headers.get('Upgrade');
		if (upgradeHeader !== 'websocket') {
			return new Response('Expected WebSocket', { status: 426 });
		}

		// Verifikasi sender dari header yang di-inject oleh Worker
		const verifiedUserId = request.headers.get('X-Verified-User-Id');
		const verifiedUserName = request.headers.get('X-Verified-User-Name');
		if (!verifiedUserId) {
			return new Response('Unauthorized', { status: 401 });
		}

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		this.ctx.acceptWebSocket(server);

		// Simpan verified info di WebSocket attachment
		server.serializeAttachment({
			userId: verifiedUserId,
			userName: verifiedUserName || '',
		});

		const history = this.sql
			.exec('SELECT id, sender, content, type, created_at, reply_to_id, is_deleted FROM messages ORDER BY created_at DESC LIMIT 50')
			.toArray()
			.reverse();

		const enriched = history.map((m: any) => this.enrichMessage(m));
		server.send(JSON.stringify({ type: 'history', messages: enriched }));

		return new Response(null, { status: 101, webSocket: client });
	}

	private enrichMessage(m: any): any {
		const result: any = {
			id: m.id,
			sender: m.sender,
			content: m.is_deleted ? '' : m.content,
			type: m.type,
			created_at: m.created_at,
			is_deleted: m.is_deleted || 0,
		};
		if (m.reply_to_id && !m.is_deleted) {
			const replyRows = this.sql.exec('SELECT id, sender, content, is_deleted FROM messages WHERE id = ?', m.reply_to_id).toArray();
			if (replyRows.length > 0) {
				const reply: any = replyRows[0];
				result.reply_to_id = reply.id;
				result.reply_to_sender = reply.sender;
				result.reply_to_content = reply.is_deleted
					? 'Pesan dihapus'
					: reply.content.length > 80
						? reply.content.substring(0, 80) + '...'
						: reply.content;
			}
		}
		return result;
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		if (typeof message !== 'string') return;

		// Ambil verified userId dari attachment
		const attachment: any = ws.deserializeAttachment() || {};
		const verifiedUserId: string = attachment.userId;

		if (!verifiedUserId) {
			ws.send(JSON.stringify({ error: 'Sesi tidak valid' }));
			return;
		}

		let data: any;
		try {
			data = JSON.parse(message);
		} catch {
			ws.send(JSON.stringify({ error: 'Invalid JSON' }));
			return;
		}

		// === DELETE ===
		if (data.action === 'delete') {
			const messageId = data.message_id;
			if (!messageId) {
				ws.send(JSON.stringify({ error: 'message_id required' }));
				return;
			}

			// Cek kepemilikan dengan verifiedUserId (BUKAN data.sender)
			const rows = this.sql.exec('SELECT sender FROM messages WHERE id = ?', messageId).toArray();
			if (rows.length === 0) {
				ws.send(JSON.stringify({ error: 'Message not found' }));
				return;
			}
			const msg: any = rows[0];
			if (String(msg.sender).trim() !== verifiedUserId.trim()) {
				ws.send(JSON.stringify({ error: 'Hanya bisa hapus pesan sendiri' }));
				return;
			}

			this.sql.exec('UPDATE messages SET is_deleted = 1, content = "" WHERE id = ?', messageId);
			const deletePayload = JSON.stringify({ type: 'delete', message_id: messageId });
			for (const socket of this.ctx.getWebSockets()) {
				try {
					socket.send(deletePayload);
				} catch {
					/* ignore */
				}
			}
			return;
		}

		// === VALIDATE ===
		const validation = validateMessage(data);
		if (!validation.ok) {
			ws.send(JSON.stringify({ error: validation.error }));
			return;
		}
		const clean = validation.data!;

		// === RATE LIMIT ===
		if (!checkRateLimit(verifiedUserId, 100)) {
			ws.send(JSON.stringify({ error: 'Terlalu banyak pesan. Tunggu sebentar.' }));
			return;
		}

		// === PAKAI verifiedUserId sebagai sender (ignore client) ===
		const finalSender = verifiedUserId;

		const createdAt = Date.now();
		const replyToId = data.reply_to_id || null;

		const inserted = this.sql
			.exec(
				'INSERT INTO messages (sender, content, type, created_at, reply_to_id, is_deleted) VALUES (?, ?, ?, ?, ?, 0) RETURNING id',
				finalSender,
				clean.content,
				clean.type,
				createdAt,
				replyToId,
			)
			.toArray();
		const newId = (inserted[0] as any)?.id || 0;

		const payloadData: any = {
			type: 'message',
			id: newId,
			sender: finalSender,
			content: clean.content,
			messageType: clean.type,
			created_at: createdAt,
			is_deleted: 0,
		};

		if (replyToId) {
			const replyRows = this.sql.exec('SELECT id, sender, content, is_deleted FROM messages WHERE id = ?', replyToId).toArray();
			if (replyRows.length > 0) {
				const reply: any = replyRows[0];
				payloadData.reply_to_id = reply.id;
				payloadData.reply_to_sender = reply.sender;
				payloadData.reply_to_content = reply.is_deleted
					? 'Pesan dihapus'
					: reply.content.length > 80
						? reply.content.substring(0, 80) + '...'
						: reply.content;
			}
		}

		const payload = JSON.stringify(payloadData);
		for (const socket of this.ctx.getWebSockets()) {
			try {
				socket.send(payload);
			} catch {
				/* ignore */
			}
		}

		this.ctx.waitUntil(this.sendFcmToOfflineUsers(finalSender, clean.content));
	}

	private async sendFcmToOfflineUsers(senderId: string, content: string): Promise<void> {
		try {
			const env = this.env as Env;
			const roomId = (await this.ctx.storage.get<string>('roomId')) || '';
			const tokenRegistryId = env.TOKEN_REGISTRY.idFromName('global');
			const tokenStub = env.TOKEN_REGISTRY.get(tokenRegistryId);

			const response = await tokenStub.fetch(
				new Request('http://x/all-except', {
					method: 'POST',
					body: JSON.stringify({ exclude_user_id: senderId }),
				}),
			);
			if (!response.ok) return;
			const data: any = await response.json();
			const tokens: Array<{ user_id: string; token: string }> = data.tokens || [];

			const { sendToToken } = await import('./fcm-sender');
			for (const t of tokens) {
				await sendToToken(env, t.token, senderId, content, { roomId });
			}
		} catch (e) {
			console.error('[FCM] Error:', e);
		}
	}

	async webSocketClose(ws: WebSocket): Promise<void> {
		/* no-op */
	}
}
