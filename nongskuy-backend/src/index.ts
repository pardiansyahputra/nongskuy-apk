import { ChatRoom } from './chat-room';
import { UserLocation } from './user-location';
import { GroupRegistry } from './group-registry';
import { MeetupRegistry } from './meetup-registry';
import { TokenRegistry } from './token-registry';
import { signJwt, verifyJwt } from './utils/jwt';
import { isValidNim, sanitizeText } from './utils/security';

export { ChatRoom, UserLocation, GroupRegistry, MeetupRegistry, TokenRegistry };

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		const corsHeaders = {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type, X-Nongskuy-Key, Authorization',
		};

		if (request.method === 'OPTIONS') {
			return new Response(null, { headers: corsHeaders });
		}

		// === HEALTH CHECK (public) ===
		if (path === '/') {
			return new Response('NONGSKUY Backend v1 — OK', {
				headers: { 'Content-Type': 'text/plain', ...corsHeaders },
			});
		}

		// === PSK CHECK (app-level auth) ===
		const psk = request.headers.get('X-Nongskuy-Key');
		if (psk !== env.API_SECRET) {
			return Response.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders });
		}

		// === AUTH LOGIN — terima data KTM, return JWT ===
		if (path === '/auth/login' && request.method === 'POST') {
			try {
				const data: any = await request.json();
				const { nim, name, faculty, prodi, umur } = data;

				const nimCheck = isValidNim(nim);
				if (!nimCheck.ok) {
					return Response.json({ error: nimCheck.error }, { status: 400, headers: corsHeaders });
				}

				const cleanName = sanitizeText(name || '', 100);
				const cleanFaculty = sanitizeText(faculty || '', 100);
				const cleanProdi = sanitizeText(prodi || '', 100);
				const cleanUmur = typeof umur === 'number' ? umur : 0;

				if (!cleanName || !cleanProdi) {
					return Response.json({ error: 'Data KTM tidak lengkap' }, { status: 400, headers: corsHeaders });
				}

				// Buat JWT
				const token = await signJwt(
					{
						userId: nim,
						name: cleanName,
						faculty: cleanFaculty,
						prodi: cleanProdi,
						umur: cleanUmur,
					},
					env.JWT_SECRET,
					30 * 24 * 60 * 60, // 30 hari
				);

				return Response.json(
					{
						ok: true,
						token,
						user: {
							nim,
							name: cleanName,
							faculty: cleanFaculty,
							prodi: cleanProdi,
							umur: cleanUmur,
						},
					},
					{ headers: corsHeaders },
				);
			} catch {
				return Response.json({ error: 'Invalid JSON' }, { status: 400, headers: corsHeaders });
			}
		}

		// === VERIFY JWT (untuk semua endpoint selain login) ===
		let authPayload: any = null;

		// Cek Authorization header
		const authHeader = request.headers.get('Authorization');
		if (authHeader && authHeader.startsWith('Bearer ')) {
			const token = authHeader.substring(7);
			authPayload = await verifyJwt(token, env.JWT_SECRET);
		}

		// Cek query param ?token= untuk WebSocket
		if (!authPayload) {
			const urlToken = url.searchParams.get('token');
			if (urlToken) {
				authPayload = await verifyJwt(urlToken, env.JWT_SECRET);
			}
		}

		if (!authPayload) {
			return Response.json({ error: 'Sesi tidak valid. Login ulang.' }, { status: 401, headers: corsHeaders });
		}

		// === Chat WebSocket ===
		if (path.startsWith('/chat/')) {
			const parts = path.split('/');
			const roomId = parts[2];
			const action = parts[3];

			if (!roomId) {
				return new Response('Room ID required', { status: 400, headers: corsHeaders });
			}
			if (!/^[a-zA-Z0-9\-_]+$/.test(roomId) || roomId.length > 100) {
				return Response.json({ error: 'Room ID tidak valid' }, { status: 400, headers: corsHeaders });
			}

			const id = env.CHAT_ROOM.idFromName(roomId);
			const stub = env.CHAT_ROOM.get(id);

			if (action === 'clear-all' && request.method === 'POST') {
				return stub.fetch(new Request('http://x/clear-all', { method: 'POST' }));
			}

			await stub.fetch(
				new Request('http://x/set-room-id', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ roomId, userId: authPayload.userId }),
				}),
			);

			// Pass authPayload via header ke DO
			const headers = new Headers(request.headers);
			headers.set('X-Verified-User-Id', authPayload.userId);
			headers.set('X-Verified-User-Name', authPayload.name || '');

			const newRequest = new Request(request.url, {
				method: request.method,
				headers,
				body: request.body,
			});

			return stub.fetch(newRequest);
		}

		// === Location ===
		if (path.startsWith('/location/')) {
			const id = env.USER_LOCATION.idFromName('global');
			const stub = env.USER_LOCATION.get(id);
			return forwardWithAuth(stub, request, path, '/location', corsHeaders, authPayload);
		}

		// === Group ===
		if (path.startsWith('/group/')) {
			const id = env.GROUP_REGISTRY.idFromName('global');
			const stub = env.GROUP_REGISTRY.get(id);
			return forwardWithAuth(stub, request, path, '/group', corsHeaders, authPayload);
		}

		// === Meetup ===
		if (path.startsWith('/meetup/')) {
			const id = env.MEETUP_REGISTRY.idFromName('global');
			const stub = env.MEETUP_REGISTRY.get(id);
			return forwardWithAuth(stub, request, path, '/meetup', corsHeaders, authPayload);
		}

		// === Token ===
		if (path.startsWith('/token/')) {
			const id = env.TOKEN_REGISTRY.idFromName('global');
			const stub = env.TOKEN_REGISTRY.get(id);
			return forwardWithAuth(stub, request, path, '/token', corsHeaders, authPayload);
		}

		return new Response('Not Found', { status: 404, headers: corsHeaders });
	},

	async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
		console.log('[Cron] Cleanup grup tidak aktif');
		const id = env.GROUP_REGISTRY.idFromName('global');
		const stub = env.GROUP_REGISTRY.get(id);
		ctx.waitUntil(stub.fetch(new Request('http://x/cleanup-inactive', { method: 'POST' })));
	},
} satisfies ExportedHandler<Env>;

async function forwardWithAuth(
	stub: DurableObjectStub,
	request: Request,
	path: string,
	prefix: string,
	corsHeaders: Record<string, string>,
	authPayload: any,
): Promise<Response> {
	const relativePath = path.replace(prefix, '');
	const newUrl = new URL(request.url);
	newUrl.pathname = relativePath;

	// Inject verified user_id dan name ke header — DO akan pakai ini,
	// bukan body user_id dari client
	const headers = new Headers(request.headers);
	headers.set('X-Verified-User-Id', authPayload.userId);
	headers.set('X-Verified-User-Name', authPayload.name || '');

	const newRequest = new Request(newUrl.toString(), {
		method: request.method,
		headers,
		body: request.body,
	});

	const response = await stub.fetch(newRequest);
	const newResponse = new Response(response.body, response);
	Object.entries(corsHeaders).forEach(([k, v]) => {
		newResponse.headers.set(k, v);
	});
	return newResponse;
}
