// ============================================================
// JWT Sign/Verify — HS256 via Web Crypto API
// ============================================================

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64UrlEncode(input: ArrayBuffer | Uint8Array | string): string {
	let bytes: Uint8Array;
	if (typeof input === 'string') {
		bytes = encoder.encode(input);
	} else if (input instanceof ArrayBuffer) {
		bytes = new Uint8Array(input);
	} else {
		bytes = input;
	}
	let binary = '';
	for (let i = 0; i < bytes.byteLength; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str: string): Uint8Array {
	let s = str.replace(/-/g, '+').replace(/_/g, '/');
	while (s.length % 4) s += '=';
	const binary = atob(s);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

async function getKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/**
 * Sign JWT HS256.
 */
export async function signJwt(payload: Record<string, any>, secret: string, expiresInSec: number = 30 * 24 * 60 * 60): Promise<string> {
	const header = { alg: 'HS256', typ: 'JWT' };
	const now = Math.floor(Date.now() / 1000);
	const fullPayload = { ...payload, iat: now, exp: now + expiresInSec };

	const headerB64 = base64UrlEncode(JSON.stringify(header));
	const payloadB64 = base64UrlEncode(JSON.stringify(fullPayload));
	const data = `${headerB64}.${payloadB64}`;

	const key = await getKey(secret);
	const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
	const sigB64 = base64UrlEncode(signature);

	return `${data}.${sigB64}`;
}

/**
 * Verify JWT HS256. Return payload atau null kalau invalid.
 */
export async function verifyJwt(token: string, secret: string): Promise<any | null> {
	try {
		const parts = token.split('.');
		if (parts.length !== 3) return null;
		const [headerB64, payloadB64, sigB64] = parts;

		const data = `${headerB64}.${payloadB64}`;
		const key = await getKey(secret);
		const signature = base64UrlDecode(sigB64);

		const valid = await crypto.subtle.verify('HMAC', key, signature, encoder.encode(data));
		if (!valid) return null;

		const payloadJson = decoder.decode(base64UrlDecode(payloadB64));
		const payload = JSON.parse(payloadJson);

		const now = Math.floor(Date.now() / 1000);
		if (payload.exp && payload.exp < now) return null;

		return payload;
	} catch {
		return null;
	}
}
