/**
 * Helper untuk kirim FCM notifikasi dari DO manapun.
 */

export async function sendFcmToUser(
	env: Env,
	userId: string,
	title: string,
	body: string,
	data?: Record<string, string>,
): Promise<boolean> {
	try {
		const tokenRegistryId = env.TOKEN_REGISTRY.idFromName('global');
		const stub = env.TOKEN_REGISTRY.get(tokenRegistryId);

		const resp = await stub.fetch(new Request(`http://x/tokens/${userId}`));
		if (!resp.ok) return false;

		const tokenData: any = await resp.json();
		if (!tokenData.token) return false;

		const { sendToToken } = await import('./fcm-sender');
		return await sendToToken(env, tokenData.token, title, body, data);
	} catch (e) {
		console.error('[FCM] Helper error:', e);
		return false;
	}
}

export async function sendFcmToUsers(
	env: Env,
	userIds: string[],
	title: string,
	body: string,
	data?: Record<string, string>,
): Promise<void> {
	try {
		if (userIds.length === 0) return;

		const tokenRegistryId = env.TOKEN_REGISTRY.idFromName('global');
		const stub = env.TOKEN_REGISTRY.get(tokenRegistryId);

		const resp = await stub.fetch(new Request('http://x/all', { method: 'POST' }));
		if (!resp.ok) return;

		const tokenData: any = await resp.json();
		const tokens: Array<{ user_id: string; token: string }> = tokenData.tokens || [];

		const { sendToToken } = await import('./fcm-sender');

		for (const t of tokens) {
			if (userIds.includes(t.user_id)) {
				await sendToToken(env, t.token, title, body, data);
			}
		}
	} catch (e) {
		console.error('[FCM] Helper error:', e);
	}
}
